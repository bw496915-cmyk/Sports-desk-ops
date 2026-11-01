# Manager boot HAR capture — pipeline proof (gate i)

**Not** “operator produces a fixture by hand.” Closure is:

1. **`bun run capture:f402-har -- --profile …`** with an **already signed-in** dataStore (preferred), or **`--login`** to refresh via **keychain** (`bun run secrets:f402 set`) or **TTY** (hidden password). **`F402_PASSWORD` in env is not read** unless deprecated `F402_ALLOW_ENV_CREDENTIALS=1`.
2. **MFA / CAPTCHA:** automated `--login` may fail. **Bootstrap once by hand** (open manager in the same Chrome profile directory), then re-run capture **without** `--login`.
3. In-process capture (same as before):
4. CDP `Network.getResponseBody` → **`redactHarJsonText`** → **`assertRedactedCaptureSweep`** → **`Bun.write`** (never raw).
5. Write **`*.redaction-proof.json`** with **`harSha256`** (SHA-256 of the **committed redacted HAR bytes**). Gate recomputes hash on every verify — proof cannot outlive a re-edit.
6. **Verifier exercised without a session:** `bun test lib/f402_har_redaction_proof_verify.test.ts` (synthetic green → ok, red → failed).
7. **Gate i′ (real shape):** one live capture proves the redactor on production-sized wire; commit HAR + proof → `harRedactionProofGate.status: ready` → **`verify:manager-har-redaction-proof`** exit **0**. Until then exit **10** BLOCKED.

If sweep fails after capture, exit **1** FAILED — fix the redactor, do not commit.

## Gate chain

| Step | What |
|------|------|
| **(n)** | Synthetic fixtures — verifier pass/fail observed in CI |
| **(i′)** | Real capture — ~2.5k `GENERAL`, ~5.7k `PLAYERS` source (fixture stores `PLAYERS: []`) |
| **(j)** | Production GENERAL fixture + oracle snapshot pin |
| **(k)** | Variance index N≥3 (live + synthetic-oracle rows) |

## Troubleshooting / raw exports (macOS)

If DevTools or Notes saves **`*.rtf`** instead of plain JSON:

```bash
textutil -convert txt scratch/export.rtf -output scratch/.tmp-f402-extract.txt
bun run extract:f402-har-from-scratch -- --in scratch/.tmp-f402-extract.txt
```

The export often concatenates a **WebInspector HAR** (`{ "log": … }`) with a trailing `{"GENERAL":…}` paste. **`extract:f402-har-from-scratch`** uses the HAR prefix only. For envelope-only recovery, locate `{"GENERAL"` inside the HAR response body or use **`redact:f402-envelope`** on extracted JSON under **`scratch/`** only (never commit raw).
