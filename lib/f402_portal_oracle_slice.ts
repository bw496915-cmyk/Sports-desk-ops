/**
 * Re-slice portal methods from pinned manager.js and compare to committed `extracted/*.body.js`.
 */

import { join } from "node:path";

import {
  loadPinnedManifest,
  sha256HexFile,
  type PinnedManifest,
} from "./f402_portal_version_pin.ts";

export const ORACLE_EXTRACTED_METHODS = [
  "baseHeriarchy",
  "buildTree",
  "findInTree",
  "setCompleteHeriarchy",
] as const;

export type OracleExtractedMethod = (typeof ORACLE_EXTRACTED_METHODS)[number];

const PINNED_DIR = join(
  import.meta.dir,
  "../verification/manager-boot-oracle/pinned",
);
const EXTRACTED_DIR = join(
  import.meta.dir,
  "../verification/manager-boot-oracle/extracted",
);

export function sliceMethodBodyFromManager(
  managerSrc: string,
  name: OracleExtractedMethod,
): string {
  const needle = `${name}:function(`;
  const start = managerSrc.indexOf(needle);
  if (start < 0) throw new Error(`method not found in manager.js: ${name}`);
  let i = managerSrc.indexOf("{", start);
  if (i < 0) throw new Error(`no opening brace for ${name}`);
  let depth = 0;
  for (let j = i; j < managerSrc.length; j += 1) {
    const ch = managerSrc[j];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const head = managerSrc.slice(start, i + 1);
        const inner = managerSrc.slice(i + 1, j);
        return `${head}${inner}}`;
      }
    }
  }
  throw new Error(`unbalanced braces slicing ${name}`);
}

export function sliceAllMethodsFromManager(
  managerSrc: string,
): Record<OracleExtractedMethod, string> {
  const out = {} as Record<OracleExtractedMethod, string>;
  for (const name of ORACLE_EXTRACTED_METHODS) {
    out[name] = sliceMethodBodyFromManager(managerSrc, name);
  }
  return out;
}

export interface OracleSliceMismatch {
  readonly method: OracleExtractedMethod;
  readonly kind: "missing_file" | "bytes_differ" | "hash_manifest";
  readonly detail: string;
}

export async function diffExtractedSlicesAgainstPinnedManager(): Promise<
  OracleSliceMismatch[]
> {
  const manifest = await loadPinnedManifest();
  const managerPath = join(PINNED_DIR, "manager.js");
  const pinnedManagerHash =
    manifest.artifacts["app/manager/manager.js"]?.sha256;
  const liveManagerHash = await sha256HexFile(managerPath);
  const mismatches: OracleSliceMismatch[] = [];
  if (
    pinnedManagerHash !== undefined &&
    liveManagerHash !== pinnedManagerHash
  ) {
    mismatches.push({
      method: "baseHeriarchy",
      kind: "hash_manifest",
      detail: `pinned/manager.js sha256 ${liveManagerHash} != manifest ${pinnedManagerHash}`,
    });
  }

  const managerSrc = await Bun.file(managerPath).text();
  const fresh = sliceAllMethodsFromManager(managerSrc);

  for (const name of ORACLE_EXTRACTED_METHODS) {
    const path = join(EXTRACTED_DIR, `${name}.body.min.js`);
    const file = Bun.file(path);
    if (!(await file.exists())) {
      mismatches.push({
        method: name,
        kind: "missing_file",
        detail: path,
      });
      continue;
    }
    const onDisk = await file.text();
    if (onDisk !== fresh[name]) {
      mismatches.push({
        method: name,
        kind: "bytes_differ",
        detail: `re-slice from pinned/manager.js differs from extracted/${name}.body.min.js — run: node verification/manager-boot-oracle/slice-methods.mjs`,
      });
    }
    const manifestKey = `extracted/${name}.body.min.js`;
    const expectedHash = manifest.artifacts[manifestKey]?.sha256;
    if (expectedHash !== undefined) {
      const liveHash = await sha256HexFile(path);
      if (liveHash !== expectedHash) {
        mismatches.push({
          method: name,
          kind: "hash_manifest",
          detail: `${name}.body.js sha256 ${liveHash} != manifest ${expectedHash}`,
        });
      }
    }
  }
  return mismatches;
}

export async function assertOracleSlicesFresh(): Promise<void> {
  const mismatches = await diffExtractedSlicesAgainstPinnedManager();
  if (mismatches.length === 0) return;
  const lines = mismatches.map((m) => `[${m.method}] ${m.kind}: ${m.detail}`);
  throw new Error(
    `manager-boot-oracle slice guard failed:\n${lines.join("\n")}`,
  );
}

export function extractedArtifactManifestKeys(): string[] {
  return ORACLE_EXTRACTED_METHODS.map((m) => `extracted/${m}.body.min.js`);
}

export type PinnedManifestWithExtracted = PinnedManifest & {
  readonly productionOracleGate?: {
    readonly generalFixture: string;
    readonly nestedSnapshotSha256: string | null;
    readonly status: "blocked" | "ready";
    readonly ownerRole: string;
    readonly captureActor: string;
    readonly requires: string;
  };
  readonly harRedactionProofGate?: {
    readonly status: "blocked" | "ready";
    readonly ownerRole: string;
    readonly harPath: string;
    readonly proofPath: string;
    readonly requires: string;
  };
  readonly varianceGate?: {
    readonly status: "blocked" | "ready";
    readonly minimumCaptures: number;
    readonly indexPath: string;
    readonly ownerRole: string;
    readonly requires: string;
  };
};
