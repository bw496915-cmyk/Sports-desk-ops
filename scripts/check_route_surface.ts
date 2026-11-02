#!/usr/bin/env bun
/**
 * Fail when the daemon's served surface and the documented surface disagree.
 *
 *   bun run scripts/check_route_surface.ts
 *
 * The three views (if-chain arms, ledger surfaces, spec paths) are hand-maintained; this is the
 * only thing that compares them. Reports; never edits.
 */

import { resolve } from "node:path";
import {
  compareRouteSurfaces,
  readRouteSurfaceInputs,
} from "../lib/route_surface.ts";

const root = resolve(import.meta.dir, "..");
const { served, declared, spec } = readRouteSurfaceInputs(root);
const findings = compareRouteSurfaces({ served, declared, spec });

if (findings.length === 0) {
  console.log(
    `check:route-surface: ok — ${served.size} served path(s), ${declared.size} declared`,
  );
  process.exit(0);
}

// Deliberately not wired into verify:docs yet: the outstanding findings are eight served routes
// the spec does not publish, and adding them needs a builder per operation. Wire it in when the
// count reaches zero, or the gate will be red for a known reason and get ignored.

console.error(
  `check:route-surface: ${findings.length} disagreement(s) between served (${served.size}) and declared (${declared.size})`,
);
for (const finding of findings) {
  console.error(`  [${finding.kind}] ${finding.path} — ${finding.detail}`);
}
process.exit(1);
