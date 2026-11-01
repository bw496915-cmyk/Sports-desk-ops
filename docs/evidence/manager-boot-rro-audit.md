# RRO audit — pinned `manager.js` (bust 1.0.280)

SHA-256 `82c3d4ec9b5d0531b06219761f0b40db20bf07f4f4250eacdabf527e90e01937`.

## Question

Is `RRO` ever **per-agent** on the wire, or always the session **`util.RRO`** singleton?

## `getCompleteHeriarchy` caller chain

| Step | Location | RRO on wire |
|------|----------|-------------|
| Boot | `main-manager.js` (via `getAccountInfo` → `setAccountInfo`) | — |
| UI delay | `settings:function` — `setTimeout(..., 500)` when `AgentMenuStyle === "Tile Menu"`, else immediate | — |
| Call site | **Only** `e.getCompleteHeriarchy()` (no arguments at call sites in pinned bundle) | — |
| Request build | `getCompleteHeriarchy:function(e)` | **`RRO: n.RRO`** always |

Extracted request object (portal):

```text
s = {
  agentID: i.agentID,
  agentType: i.agentType,
  operation: "getListAgenstByAgent",
  RRO: n.RRO
}
```

`i = $.extend({ agentID: a.ID, agentType: a.accountInfo.AgentType }, e)` — optional caller arg `e` can
override **agentID/agentType** only through `i`; **`s` does not read `i.RRO` or `e.RRO`**.

**Conclusion (#3):** No RRO override on the `getCompleteHeriarchy` path. Hierarchy load always sends
**`util.RRO`**.

## Whole-bundle `RRO` grep (manager.js)

```text
rg -o 'RRO[^,}]{0,40}' verification/manager-boot-oracle/pinned/manager.js | sort | uniq -c
```

| Count | Pattern |
|------:|---------|
| 17 | `RRO:n.RRO` |
| 4 | `RROR.icon` (unrelated substring) |

No `RRO:1` literal, no `RRO:i.`, no per-row `GENERAL[].RRO` in client POST builders.

## `util.js` source of truth

Pinned `util.js` defines **`RRO:1`** on the util singleton (alongside `apiPath:"/cloud/"`). Manager
modules hold `n = new util` and reference **`n.RRO`** everywhere.

## Runtime mutation (`.RRO =`)

Pinned bundle set (`manager.js`, `util.js`, `security.js`, `version.js`):

```text
rg '\.RRO\s*=' pinned/*.js   → 0 matches
node match for RRO= (assignment) → 0 matches
```

`RRO:1` in `util.js` is an **object literal property at module definition**, not a post-load assignment.
**Conclusion:** Client sends **`n.RRO`** read from util initialized to **1**; no evidence in pinned
artifacts that any code reassigns `RRO` after load. “Always 1 on wire” = **always reads `n`, which starts
at 1** until a future bundle introduces assignment (re-grep on bust drift).

**Non-assignment mutation (note-and-close):** Pinned set also checked for `Object.assign(…RRO…)` and
spread/`{…RRO…}` patterns — **0 matches** in `manager.js`, `util.js`, `security.js`, `version.js`.
Re-run on bust drift; not urgent.

## `getHeriarchy` (separate op, byte ~33085)

Same quirk as hierarchy boot load:

```text
i = { agentID: a.agentID, operation: "getHeriarchy", RRO: n.RRO }
```

Not the `GENERAL`/`PLAYERS` envelope — response `e.LIST` → `setHeriarchy` — but **RRO on the wire is
the same singleton**, not per-agent.

## Repo replay default

`F402_RRO` / `MANAGER_RRO` in `lib/f402_hierarchy_config.ts` defaults to **`1`**, matching portal util.

## Per-agent hypothesis

**Rejected** for client-authored Manager POSTs in this bundle: RRO is not derived from `accountInfo`,
`GENERAL` rows, or call-site arguments on `getCompleteHeriarchy`.

Server-side interpretation of `RRO` is out of scope for this grep; capture variance belongs in HAR
evidence, not client inference.
