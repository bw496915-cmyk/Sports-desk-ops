# Pinned portal artifacts

Hashes are authoritative in **`manifest.json`** (compare with `fetch-pinned-bundles.sh`).

| Artifact      | Role                                                               |
| ------------- | ------------------------------------------------------------------ |
| `version.js`  | Bust string source; drift = **SHA-256**, not semver string compare |
| `manager.js`  | Oracle extraction + RRO grep                                       |
| `util.js`     | `apiPath`, `RRO:1`                                                 |
| `security.js` | qubic→cloud ajax prefilter                                         |

Re-fetch (no credentials):

```bash
bash verification/manager-boot-oracle/pinned/fetch-pinned-bundles.sh
bun run fetch:pinned-portal   # Bun TLS vs bundle-byte drift class
```

Runtime pin (Bun + JSC) lives in **`manifest.json` → `runtime`**. CI and gates call
`verify:manager-oracle-slices` (includes runtime + slice guard).

After manager hash changes, re-slice (**separate from `bun fmt`** — slices are `*.body.min.js`):

```bash
node verification/manager-boot-oracle/slice-methods.mjs
```

Always-on drift: `bun run portal:drift:cron --watch` (spawned checks use pinned `bunExecutablePath`).
