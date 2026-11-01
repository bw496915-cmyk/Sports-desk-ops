#!/usr/bin/env bun
/**
 * Fetch pinned portal bundles with Bun 1.4.4+ fetch; print SHA-256 and drift class.
 * Complements curl in fetch-pinned-bundles.sh (TLS-trust vs bundle-byte split).
 */
import { join } from "node:path";

import {
  classifyBundleDrift,
  fetchPortalArtifactBytes,
  type PortalBundleDriftRow,
} from "../../lib/f402_portal_bundle_fetch.ts";
import { loadPinnedManifest } from "../../lib/f402_portal_version_pin.ts";

const PINNED_DIR = join(
  import.meta.dir,
  "../../verification/manager-boot-oracle/pinned",
);

const BASE = (Bun.env.F402_BASE_URL ?? "https://www.fantasy402.com").replace(
  /\/$/,
  "",
);
const BUST = Bun.env.F402_PINNED_MANAGER_BUST ?? "1.0.280";

const ARTIFACTS = [
  { key: "app/setting/version.js", file: "version.js" },
  { key: "app/manager/manager.js", file: "manager.js" },
  { key: "app/util/util.js", file: "util.js" },
  { key: "app/system/security.js", file: "security.js" },
] as const;

const manifest = await loadPinnedManifest();
const rows: PortalBundleDriftRow[] = [];

for (const { key, file } of ARTIFACTS) {
  const pinnedSha256 = manifest.artifacts[key]?.sha256;
  if (pinnedSha256 === undefined) throw new Error(`manifest missing ${key}`);
  const url = `${BASE}/${key}?bust=${BUST}`;
  const outcome = await fetchPortalArtifactBytes(url);
  const driftKind = classifyBundleDrift(pinnedSha256, outcome);
  rows.push({ artifact: key, url, pinnedSha256, outcome, driftKind });

  if (outcome.kind === "ok") {
    await Bun.write(join(PINNED_DIR, file), outcome.body);
    console.log(`${outcome.sha256}  ${join(PINNED_DIR, file)} (${driftKind})`);
  } else {
    console.error(JSON.stringify({ artifact: key, outcome, driftKind }));
  }
}

const bundleByte = rows.filter((r) => r.driftKind === "bundle_byte");
const tls = rows.filter((r) => r.driftKind === "tls_trust");
if (tls.length > 0) {
  console.error(
    JSON.stringify({
      signal: "F402_PORTAL_TLS_TRUST_DRIFT",
      rows: tls,
    }),
  );
}
if (bundleByte.length > 0) {
  console.error(
    JSON.stringify({
      signal: "F402_PORTAL_BUNDLE_BYTE_DRIFT",
      rows: bundleByte,
    }),
  );
  process.exit(1);
}
if (tls.length > 0) process.exit(2);
console.log("Compare hashes to pinned/manifest.json");
