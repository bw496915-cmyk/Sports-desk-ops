#!/usr/bin/env bun
/**
 * One automated refresh for the BILLY666 agent feed:
 *   1. getListAgenstByAgent → projected envelope → structural roster (no passwords/names)
 *   2. getWeeklyFigureByAgentLite → weekly figures
 * Both go through the replay transport; --dry-run prints the redacted request bodies and does
 * no network work. An expired session exits non-zero with the remediation, not a partial success.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildHierarchyFormBody } from "../lib/f402_hierarchy_envelope.ts";
import { PROBE_HOST, MANAGER_RRO } from "../lib/f402_hierarchy_config.ts";
import { createF402ReplayTransport } from "../lib/f402_replay_transport.ts";
import {
  WEEKLY_FIGURE_LITE_PATH,
  buildWeeklyFigureLiteFormBody,
  parseWeeklyFigureLite,
} from "../lib/f402_weekly_figure_lite.ts";
import {
  assertProjectedRoster,
  projectUsersRoster,
} from "../lib/users_roster.ts";

const ROOT = join(import.meta.dir, "..");
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "agent-id": { type: "string", default: "BILLY666" },
    "agent-type": { type: "string", default: "M" },
    "agent-owner": { type: "string" },
    out: { type: "string", default: join(ROOT, "Scratch", "agent-feed") },
    "dry-run": { type: "boolean", default: false },
  },
});
const agentId = values["agent-id"].trim();
const agentType = values["agent-type"].trim();
const agentOwner = values["agent-owner"]?.trim() ?? agentId;

if (values["dry-run"]) {
  console.log(
    JSON.stringify(
      {
        hierarchy: {
          url: `${PROBE_HOST}/cloud/api/Manager/getListAgenstByAgent`,
          body: Object.fromEntries(
            buildHierarchyFormBody(
              { agentID: agentId, agentType, agentOwner },
              MANAGER_RRO,
            ),
          ),
          mode: "projected",
        },
        weekly: {
          url: `${PROBE_HOST}${WEEKLY_FIGURE_LITE_PATH}`,
          body: Object.fromEntries(
            buildWeeklyFigureLiteFormBody({
              agentID: agentId,
              agentOwner,
              week: 0,
              type: "A",
              layout: "byDay",
            }),
          ),
        },
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const outDir = values.out;
await mkdir(outDir, { recursive: true });
const hierarchyOut = join(outDir, "hierarchy.projected.json");
const rosterOut = join(outDir, "roster.projected.json");
const weeklyOut = join(outDir, "weekly.json");

const fetched = Bun.spawnSync({
  cmd: [
    "bun",
    "run",
    join(ROOT, "scripts/capture/f402_hierarchy_probe.ts"),
    "--fetch",
    "--players-mode",
    "projected",
    "--agent-id",
    agentId,
    "--agent-type",
    agentType,
    "--agent-owner",
    agentOwner,
    "--out",
    hierarchyOut,
  ],
  env: { ...process.env, F402_PLAYERS_MODE: "projected" },
  stdout: "pipe",
  stderr: "pipe",
});
if (fetched.exitCode !== 0) {
  const stderr = new TextDecoder().decode(fetched.stderr).trim();
  throw new Error(`hierarchy fetch failed: ${stderr || "unknown error"}`);
}
const envelope = await Bun.file(hierarchyOut).json();
const roster = projectUsersRoster(envelope);
assertProjectedRoster(roster);
await Bun.write(rosterOut, `${JSON.stringify(roster, null, 2)}\n`);

const transport = await createF402ReplayTransport();
let weeklyRaw: unknown;
try {
  const response = await transport.fetch(
    `${PROBE_HOST}${WEEKLY_FIGURE_LITE_PATH}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
      },
      body: buildWeeklyFigureLiteFormBody({
        agentID: agentId,
        agentOwner,
        week: 0,
        type: "A",
        layout: "byDay",
      }).toString(),
      redirect: "manual",
    },
  );
  if (response.status === 401 || response.redirected) {
    throw new Error("session expired — re-auth required");
  }
  if (!response.ok) throw new Error(`weekly ${response.status}`);
  weeklyRaw = await response.json();
} finally {
  await transport.close();
}
let weekly: unknown;
try {
  weekly = parseWeeklyFigureLite(weeklyRaw);
} catch (error) {
  weekly = {
    kind: "unparsed",
    error: error instanceof Error ? error.message : String(error),
  };
}
await Bun.write(
  weeklyOut,
  `${JSON.stringify({ fetchedAt: new Date().toISOString(), agentId, weekly, raw: weeklyRaw }, null, 2)}\n`,
);

console.log(
  JSON.stringify(
    {
      ok: true,
      agentId,
      hierarchy: {
        agents: roster.agents.length,
        players: roster.players.length,
        path: hierarchyOut,
      },
      roster: { path: rosterOut },
      weekly: {
        path: weeklyOut,
        kind: (weekly as { kind?: string }).kind ?? "unknown",
      },
    },
    null,
    2,
  ),
);
