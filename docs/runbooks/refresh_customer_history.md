# Refresh retained customer history on the collector schedule

The webview daemon owns `sched_customer_history_15m`, at :12, :27, :42 and :57
America/Chicago. The bot excludes this daemon-owned schedule. It invokes
`scripts/refresh_customer_history.ts` through the existing shell-capture runner;
this job does not send a message or authenticate to a provider.

Configure the daemon process (not a committed environment file):

```sh
SPORTSDESK_CUSTOMER_HISTORY_PROJECTOR=/absolute/dashboard/scripts/project_customer_history.ts
SPORTSDESK_CUSTOMER_HISTORY_SOURCES='["/private/graded-today.json","/private/graded-window.json"]'
SPORTSDESK_CUSTOMER_HISTORY_JSON=/private/dashboard/customer-history.json
```

Use the same output path in the dashboard. The projector is owned and versioned
by `Local-Sportsdesk-ops`; this collector does not duplicate its financial arithmetic.
Missing configuration skips the schedule. Restart the daemon after changing its
configuration. To exercise exactly the scheduled command manually, run:

```sh
bun --no-env-file run scripts/refresh_customer_history.ts
```

The wrapper runs the dashboard projector using the daemon's pinned Bun executable,
with an explicit environment containing only PATH and HOME, no GSLive/F402 secrets,
`--no-env-file` and a two-minute timeout. Exports are local inputs; **this job does
not capture upstream graded reports**. Their existing producers still need to
refresh them. A new projection is not evidence that the input event window is current.

The dashboard projector hashes all inputs and its own implementation. Unchanged
inputs/code keep the existing output and original generation time. Invalid or
missing inputs fail without replacing the last good projection. Retained W/L,
financial exclusions, ambiguous identities and provisional-return labels remain
owned by the dashboard contracts; this is never complete account history.

An exclusive `<output>.refresh-lock` prevents concurrent writers. The private
`<output>.status.json` records attempt time, `updated`/`unchanged`/`failed`, projection
time on success, and `upstreamCapturePerformed: false`. Overlaps are logged as
`overlap-skipped` and do not replace the active writer's receipt. Before removing a
stale lock after a crash, verify no refresh process is running. Configuration errors
are reported by the scheduler/CLI; only attempts with valid configuration and an
acquired lock write a receipt. No raw account records or credentials are logged.
