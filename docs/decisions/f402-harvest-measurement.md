# F402 persistent-page harvester — measurement and fallback design

Status: **design only** (B prototype, default off). No live-path code. Prerequisites: #315
(derived expiry) and #316 (silence watchdog), both at the
`checkpoint/2026-11-17-f402` commit.

## Why

The refresher re-authenticates through the WebView whenever the derived expiry approaches —
roughly 70–150 credential logins/day depending on the old stopgap. Portal 1.0.287 already
rotates `sessionStorage.token` in-page every 5 minutes (`security.js verifySession`,
`timeRefresh: 3e5`), but the desk closes the page and logs in again. B mirrors the vendor
rotation from one persistent page instead of re-authenticating.

## Proposed path (behind `F402_HARVEST=1`, default off)

- One authenticated headless page per host; the vendor rotates the bearer.
- Every 30–60 s mirror `sessionStorage.token` + `MASTER_ID` into the 0600 session file through
  `sessionFromAuth`, which derives `expiresAtIso = min(now + ttl, exp - 2 min)`.
- On page death, token stagnation (no `exp` advance for two 5-minute windows), or a
  vendor-shape change, fall back to the existing `session_login` path and journal
  `fallback=<reason>`.
- The watchdog covers the harvester too: either reuse the `f402-session-refresh` journal (same
  tick shape) or add a distinct kind the watchdog reads. Do not leave the harvester outside the
  silence check.
- Kill switch: unset `F402_HARVEST`; the installed re-login runner remains the fallback.

## Measurement table (7-day sample, 24 h warm-up excluded)

| Metric         | Definition / source                                                 | Baseline (re-login)           | Acceptance                                               |
| -------------- | ------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------- |
| logins/day     | successful `session_login` spawns; journal `minted:true`            | measure 24 h on the same host | ≤ 2/day after warm-up                                    |
| page lifetime  | first successful auth → page death                                  | n/a                           | ≥ 7 days                                                 |
| RSS            | max resident set of the browser process                             | measure                       | provisional; set after the baseline; start with ≤ 400 MB |
| fallback rate  | fallback ticks / total ticks                                        | n/a                           | ≤ 5%                                                     |
| page restarts  | relaunches/day                                                      | n/a                           | ≤ 1/day                                                  |
| token rotation | `exp` advances every ~5 min without a mint; `tokenWindowMin` 21 ± 2 | n/a                           | 100% of sampled hours                                    |

Report median and p95, not just the mean. The 24 h baseline is measured on the same host before
enabling the flag. Any metric outside acceptance keeps the flag off — it is not a default-on
decision.

## Fallback and safety

- Never write a token whose `exp` is inside the 2-minute margin; mint through the re-login path.
- The re-login runner stays installed and reachable; the watchdog pages if neither path journals.
- No token, cookie, or password values in logs. The journal carries only
  `nbfIso`/`expIso`/`windowMinutes` and classifier strings.
- Vendor behavior is external: the 5-minute rotation check and `tokenWindowMin` are tripwires.
  A change falls back; it never guesses.
- The 7-day sample is one host, not fleet-wide. Fleet rollout needs a second sample on a host
  with different traffic.

## Rollout

1. One host, `F402_HARVEST=1`, re-login runner still installed.
2. Measure the table for 7 days; keep the flag scoped to that host.
3. Review at the checkpoint commit. Default-on is a separate decision with the measured table
   and the fallback evidence attached; otherwise close B as not worth a resident browser.

## Open questions

- Headless browser memory and sleep/suspension behavior on the desk host.
- Vendor anti-bot/logout behavior over multi-day pages.
- Whether the 5-minute rotation continues while the page is backgrounded.
- Whether the same page can serve the hierarchy probe and the report fetches, or only the
  session mirror.
