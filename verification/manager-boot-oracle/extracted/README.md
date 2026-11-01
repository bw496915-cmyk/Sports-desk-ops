# Extracted portal methods (from pinned `manager.js`)

Source: `app/manager/manager.js?bust=1.0.280`, SHA-256
`82c3d4ec9b5d0531b06219761f0b40db20bf07f4f4250eacdabf527e90e01937`.

| File                           | Portal method          | Bytes (body)                     |
| ------------------------------ | ---------------------- | -------------------------------- |
| `baseHeriarchy.body.js`        | `baseHeriarchy`        | full `name:function(e){…}` slice |
| `buildTree.body.js`            | `buildTree`            | 286                              |
| `findInTree.body.js`           | `findInTree`           | 87                               |
| `setCompleteHeriarchy.body.js` | `setCompleteHeriarchy` | 1885                             |

Regenerate after bust drift: run `pinned/fetch-pinned-bundles.sh`, re-slice with
`verification/manager-boot-oracle/slice-methods.mjs`, update `extracted/*` hashes in
`pinned/manifest.json`.

**Pretest:** `bun run verify:manager-oracle-slices` re-slices `pinned/manager.js` and diffs against
these files (stale slices fail even when oracle unit tests pass).

**Parser rule:** Reproduce the **pinned** bundle (see manifest hash), not a corrected tree. On bust drift,
re-slice + refresh compat tests; see `docs/evidence/manager-boot-hierarchy.md`.
