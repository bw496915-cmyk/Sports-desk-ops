# Variance gate (g) — characterize before parser hardening

**Owner role:** `operator` (Desk engagement owner for Fantasy402 manager-boot captures).

**Prerequisite gates:** (a) slice guard, (e) redaction-validated production oracle fixture, (f) CI slice job.

## Purpose

After the portal oracle is proven on **synthetic** and **one redacted production GENERAL**, parser and
normalizer work must cite **observed variance** across **N ≥ 3** index rows — not speculation.

Rows may be **`live-redacted`** (HAR path) or **`synthetic-oracle`** (pinned bundle compat cases
exercised in `lib/f402_portal_hierarchy_oracle.test.ts`: L13 silent drop, L2 orphan under `""`, etc.).
Live recaptures (shallow tree, wide L5/L6, root `AgentType: "A"`) still strengthen the ledger but are
not required to start parser work once the index lists ≥3 characterized entries.

## Deliverable

1. Redact each HAR per [`manager-boot-har-redaction.md`](./manager-boot-har-redaction.md).
2. Append a row per capture to `docs/evidence/captures/har/manager-boot-variance-index.json`:

```json
{
  "captures": [
    {
      "id": "2026-11-01-session-a",
      "harPath": "docs/evidence/captures/har/2026-11-01-manager-boot.redacted.har",
      "generalCount": 2466,
      "maxLevel": 12,
      "notes": "Tile Menu / immediate hierarchy"
    }
  ]
}
```

3. When `captures.length >= 3`, set `varianceGate.status` to **`ready`** in
   `verification/manager-boot-oracle/pinned/manifest.json`.

## CI / local

```bash
bun run verify:manager-oracle-variance
```

## Discipline after (g)

Every parser or normalizer enhancement post-(g) must reference a **variance row** (capture id + field)
in PR description or `docs/evidence/manager-boot-primary-sources.md` ledger — no drive-by hardening.
