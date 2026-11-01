# HAR redaction procedure — Manager boot (`getListAgenstByAgent`)

Operator-facing spec. Apply **before** committing any capture under `docs/evidence/captures/` or
`tests/fixtures/`. Goal: preserve wire shape for oracle/parser work without secrets or session material.

## 1. Scope

- **In scope:** entries whose request URL path contains `/cloud/api/Manager/getListAgenstByAgent` and
  related boot calls (`getAccountInfoOwner`, static `manager.js` / `version.js` if needed for bust pins).
- **Out of scope for commit:** full session cookies, `Authorization`, raw `PLAYERS[].Password`, and any
  unrelated third-party HAR noise (analytics, CDN cookies).

## 2. Sentinel seeding (passwords)

1. Parse the response JSON body for the list-agents entry.
2. For **every** element of `PLAYERS[]`, if `Password` is present (string), replace the value with the
   fixed sentinel **`REDACTED_PASSWORD`** (same length not required; key must remain for shape audits).
3. Do **not** drop the `Password` key unless the capture mode is `PLAYERS: []` (hierarchy probe off-mode);
   for HAR-derived fixtures used as oracle inputs, prefer **empty `PLAYERS`** after sentinel pass, then
   strip the array to `[]` for repo storage unless a password-shape audit is explicitly required.

## 3. Request / response headers (allowlist)

After redaction, **retain only** these header names (case-insensitive) on each HAR entry:

| Header                   | Notes                                        |
| ------------------------ | -------------------------------------------- |
| `:method` / `method`     | HTTP method                                  |
| `:path` / `:url` / `url` | Path + query (scrub query tokens if present) |
| `content-type`           | Must show form vs JSON                       |
| `x-requested-with`       | Portal ajax marker                           |
| `status` / `:status`     | Response code                                |

**Remove entirely** (do not replace with placeholders):

- `cookie` / `Cookie`
- `set-cookie` / `Set-Cookie`
- `authorization` / `Authorization`
- `proxy-authorization`
- Any `x-csrf*`, `x-auth*`, or bearer-like custom headers

## 4. POST body fields (list-agents)

- **Keep:** `operation`, `RRO`, `agentType`, `agentOwner` (if present).
- **`agentID`:** replace with fixture token **`FIXTURE_AGENT_ID`** (padded wire shape optional; document
  real trim behavior in a separate private note if needed).
- Never commit live `agentID` values tied to a real account unless policy explicitly allows — treat as PII.

## 5. `agentID` / `agentType` in response `GENERAL`

These fields are **account identifiers on the wire** (login tree keys). For public repo artifacts:

- Replace each distinct `AgentID` and `Login` with deterministic placeholders:
  `AGENT_L{level}_N{index}` (preserve `Level`, `AgentType`, rate columns, `SeqNumber` unless SeqNumber is
  deemed sensitive — keep numeric sequence for oracle tests).
- Preserve **`AgentType`** values (`A` / `M`) — they are not personal data; they drive portal branches.
- Do **not** scrub `AgentType` to literals; do scrub **`Login`** and **`AgentID`** to placeholders.

## 6. `getAccountInfoOwner` entries

- JSON body: replace `agentID` with **`FIXTURE_AGENT_ID`**.
- Response: redact `accountInfo` fields that identify a person or account (email, phone, names, addresses).
  Keep **`AgentType`**, **`AgentMenuStyle`**, and other enum-like settings needed to reproduce boot order.

## 7. Validation gate (before git add)

**Load-bearing (gate i — HAR pipeline):** `capture:f402-har` → `prepareRedactedHarText` →
`lib/f402_har_redaction_sweep.ts` before any `Bun.write`. Proof artifact:
`docs/evidence/captures/har/manager-boot-pipeline-proven.redaction-proof.json`. Verify:
`bun run verify:manager-har-redaction-proof` (exit **10** until committed, **1** if sweep fails on disk).

**Security:** Raw list-agents JSON contains live passwords and PII. Keep copies only under
`scratch/` (gitignored). Never paste into chat, tickets, or CI logs. Rotate credentials if exposed.

**Scratch envelope (pre-HAR):** `bun run redact:f402-envelope -- --in scratch/…json` — local redaction
only; still pin oracle hash before `productionOracleGate` is derived ready.

**Load-bearing (gate w — extract):** `extract:f402-oracle-fixture` calls
`verifyHarRedactionProofFiles` on `--proof` + `--har` **before** reading envelope bytes. Do not extract
from an unproven HAR.

**Load-bearing (gate j — production oracle fixture):** `lib/f402_production_fixture_redaction.ts` plus
`prepareProductionOracleFixtureTextFromHar` (label-agnostic oracle equivalence via
`lib/f402_oracle_label_agnostic.ts` — not structural-only). Invoked by `verify:manager-oracle-production`
**before** the portal oracle runs. Requires:

- Top-level keys: `GENERAL`, `PLAYERS`, `EXTRA`, plus **`_f402Redaction`** `{ specVersion: 1, redactedByRole: "operator" }`.
- **`PLAYERS: []`** for repo oracle fixtures.
- **`GENERAL[].AgentID` / `Login`:** placeholders `AGENT_L{level}_N{index}` only.
- No `set-cookie`, `Authorization`, or `Bearer …` substrings in the file text.
- Any `Password` key anywhere must be **`REDACTED_PASSWORD`** (prefer empty `PLAYERS` instead).

Manual checks:

1. `rg -i 'password|set-cookie|authorization|Bearer ' <file>` → **no raw secrets** (password key with sentinel is OK).
2. `bun test lib/f402_production_fixture_redaction.test.ts`
3. `bun run verify:manifest-consistency` — `pinned/manifest.json` gate `status` must match derived
   readiness (artifacts + verify), not hand-flipped `ready`.
4. Optional dry replay: `bun run hierarchy:replay -- --mode dry --account tests/fixtures/f402-get-account-info-owner-fixture.json`

## 8. Storage layout

- Redacted HAR: `docs/evidence/captures/har/<date>-manager-boot.redacted.har`
- Extracted envelope only: `tests/fixtures/f402-list-agents-by-agent-<label>.json`
- Oracle snapshot derived from redacted `GENERAL`: document generator command in fixture README or commit
  message — parser work waits on that snapshot.
