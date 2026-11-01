/**
 * Pin the Bun runtime used by the portal hierarchy oracle (JSC/WebKit is runtime-dependent).
 */

import { join } from "node:path";

import { loadPinnedManifest } from "./f402_portal_version_pin.ts";

export interface PortalRuntimePin {
  readonly bunVersion: string;
  readonly bunRevision: string;
  /** `process.versions.webkit` — JSC/WebKit bundle revision inside Bun. */
  readonly jscRevision: string;
  readonly bunExecutablePath: string;
}

export interface PinnedManifestWithRuntime {
  readonly runtime?: PortalRuntimePin;
}

const MANIFEST_PATH = join(
  import.meta.dir,
  "../verification/manager-boot-oracle/pinned/manifest.json",
);

export function readCurrentPortalRuntimePin(
  bunExecutable: string = process.execPath,
): PortalRuntimePin {
  const webkit = process.versions.webkit;
  if (typeof webkit !== "string" || webkit === "") {
    throw new Error("process.versions.webkit missing — cannot pin JSC revision");
  }
  return {
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    jscRevision: webkit,
    bunExecutablePath: bunExecutable,
  };
}

export async function loadManifestWithRuntime(): Promise<
  PinnedManifestWithRuntime & Awaited<ReturnType<typeof loadPinnedManifest>>
> {
  return (await Bun.file(MANIFEST_PATH).json()) as PinnedManifestWithRuntime &
    Awaited<ReturnType<typeof loadPinnedManifest>>;
}

export function compareRuntimePin(
  pinned: PortalRuntimePin,
  live: PortalRuntimePin,
): string[] {
  const drift: string[] = [];
  if (pinned.bunVersion !== live.bunVersion) {
    drift.push(`bun.version ${live.bunVersion} != pinned ${pinned.bunVersion}`);
  }
  if (pinned.bunRevision !== live.bunRevision) {
    drift.push(
      `bun.revision ${live.bunRevision} != pinned ${pinned.bunRevision}`,
    );
  }
  if (pinned.jscRevision !== live.jscRevision) {
    drift.push(
      `jsc (webkit) ${live.jscRevision} != pinned ${pinned.jscRevision}`,
    );
  }
  return drift;
}

export async function assertPortalRuntimePin(options?: {
  readonly bunExecutable?: string;
}): Promise<void> {
  const manifest = await loadManifestWithRuntime();
  const pinned = manifest.runtime;
  if (pinned === undefined) {
    throw new Error("manifest missing runtime pin");
  }
  const live = readCurrentPortalRuntimePin(
    options?.bunExecutable ?? process.execPath,
  );
  const drift = compareRuntimePin(pinned, live);
  if (drift.length === 0) return;
  console.error(
    JSON.stringify({
      signal: "F402_PORTAL_RUNTIME_DRIFT",
      drift,
      pinnedExecutable: pinned.bunExecutablePath,
      liveExecutable: live.bunExecutablePath,
    }),
  );
  throw new Error(`F402_PORTAL_RUNTIME_DRIFT: ${drift.join("; ")}`);
}
