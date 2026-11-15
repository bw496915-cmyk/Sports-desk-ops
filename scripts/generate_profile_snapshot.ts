#!/usr/bin/env bun
/**
 * @file scripts/generate_profile_snapshot.ts
 * @description Freeze the 31-profile customer snapshot into a committed, tool-readable artifact.
 *
 * `data/customer-profiles.json` is an operator artifact (gitignored), so Code Mode cannot read it in
 * CI. This generator lifts the four fields the profile tools expose (`vol`, `clv`, `sharp`) plus
 * `flags` into `data/profile-snapshot.json`, which IS committed. Re-run it when the customer book is
 * rebuilt; the oracle freezes the resulting count and sentinel ids, so drift fails the suite until
 * it is re-frozen deliberately.
 *
 *   bun run scripts/generate_profile_snapshot.ts
 */

import { resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const SOURCE = resolve(REPO, "data/customer-profiles.json");
const OUT = resolve(REPO, "data/profile-snapshot.json");

interface SourceProfile {
  readonly customerId?: unknown;
  readonly book?: {
    readonly lifetimeVolumeUsd?: unknown;
    readonly clvBps?: unknown;
    readonly sharpScore?: unknown;
  };
  readonly flags?: unknown;
}

const number = (value: unknown, field: string, id: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`profile ${id}: ${field} is not a finite number`);
  }
  return value;
};

const readable = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((flag): flag is string => typeof flag === "string")
    : [];

const checkOnly = Bun.argv.includes("--check");
const sourceFile = Bun.file(SOURCE);
if (!(await sourceFile.exists())) {
  console.error(
    `profile-snapshot: source ${SOURCE.replace(REPO, ".")} is absent (gitignored operator book)`,
  );
  process.exit(2);
}

const document = (await sourceFile.json()) as {
  profiles?: SourceProfile[];
};
if (!Array.isArray(document.profiles)) {
  throw new Error(`${SOURCE} has no profiles array`);
}

const profiles = document.profiles.map((profile) => {
  const id =
    typeof profile.customerId === "string" ? profile.customerId.trim() : "";
  if (id === "")
    throw new Error("profile without customerId in the source book");
  const book = profile.book ?? {};
  return {
    id,
    vol: number(book.lifetimeVolumeUsd, "lifetimeVolumeUsd", id),
    clv: number(book.clvBps, "clvBps", id),
    sharp: number(book.sharpScore, "sharpScore", id),
    flags: readable(profile.flags),
  };
});

const serialized = `${JSON.stringify(
  {
    schemaVersion: 1,
    generatedFrom: "data/customer-profiles.json",
    fieldMap: {
      clv: "book.clvBps",
      vol: "book.lifetimeVolumeUsd",
      sharp: "book.sharpScore",
    },
    profiles,
  },
  null,
  2,
)}\n`;

if (checkOnly) {
  const committed = Bun.file(OUT);
  if (!(await committed.exists())) {
    console.error(
      `profile-snapshot: committed snapshot ${OUT.replace(REPO, ".")} is missing`,
    );
    process.exit(1);
  }
  if ((await committed.text()) !== serialized) {
    console.error(
      `profile-snapshot: ${OUT.replace(REPO, ".")} is stale — regenerate and re-freeze oracle.ts`,
    );
    process.exit(1);
  }
  console.log(
    `profile-snapshot: ok — ${profiles.length} profile(s) match ${OUT.replace(REPO, ".")}`,
  );
  process.exit(0);
}

await Bun.write(OUT, serialized);

console.log(
  `profile-snapshot: wrote ${profiles.length} profile(s) to ${OUT.replace(REPO, ".")}`,
);
