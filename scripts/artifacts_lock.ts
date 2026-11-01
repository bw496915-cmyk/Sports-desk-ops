#!/usr/bin/env bun
/**
 * @file scripts/artifacts_lock.ts
 * @description Verify (or refresh) docs/artifacts.lock.json.
 *
 *   bun run artifacts:lock            # check; exit 1 on drift
 *   bun run artifacts:lock --update   # after `bun run artifacts:value`
 *
 * The artifacts need live data to regenerate, so CI cannot rebuild them. It can still notice that
 * the generator or one of its libraries changed after the artifacts were written.
 */

import {
  type ArtifactsLock,
  buildLock,
  parseLock,
  verifyLock,
} from "../lib/artifacts_lock.ts";

const LOCK_PATH = "docs/artifacts.lock.json";
const args = process.argv.slice(2);
const update = args.includes("--update");
const json = args.includes("--json");

const current = await buildLock();

if (update) {
  const body: ArtifactsLock = current;
  const serialized = `${JSON.stringify(body, null, 2)}\n`;
  await Bun.write(LOCK_PATH, serialized);
  console.error(
    `artifacts:lock: wrote ${LOCK_PATH} (${Object.keys(current.artifacts).length} artifacts, ${Object.keys(current.inputs).length} inputs)`,
  );
  process.exit(0);
}

let recorded: ArtifactsLock;
try {
  recorded = parseLock(await Bun.file(LOCK_PATH).json());
} catch (error) {
  console.error(`artifacts:lock: ${(error as Error).message}`);
  process.exit(2);
}

const errors = verifyLock(recorded, current);

if (json) {
  console.log(JSON.stringify({ ok: errors.length === 0, errors }, null, 2));
} else {
  for (const error of errors) console.error(`artifacts:lock: ${error}`);
  console.error(
    errors.length === 0
      ? `artifacts:lock: OK · ${LOCK_PATH}`
      : `artifacts:lock: ${errors.length} error(s)`,
  );
}

if (errors.length > 0) process.exit(1);
