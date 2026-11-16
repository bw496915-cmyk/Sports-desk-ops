#!/usr/bin/env bun
/**
 * Build per-customer profiles from the customer book, offline.
 *
 *   bun run customers:profiles [--book enriched_customers_full.json]
 *                              [--tree data/agent-tree.json]
 *                              [--out data/customer-profiles.json] [--json]
 *
 * The book carries lifetime aggregates plus five recent tickets per customer, so P/L per league,
 * per market and per channel is computable without a portal session. Two things are stated rather
 * than guessed: the ticket window is a five-row sample (`sampleOnly: true`), and `GSLIVE` is a
 * channel proxy for "live", not a verified live flag.
 */

import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  buildCustomerProfiles,
  type CustomerRow,
  type TreeIndex,
} from "../lib/customer_profile.ts";
import {
  customerRowFromHarvestedProfile,
  customerRowsFromLiveCaptures,
  liveWagerRows,
} from "../lib/customer_source_rows.ts";
import { positionIdentity } from "../lib/position_identity.ts";
import { ticketWriterDisposition } from "../lib/live_writer_policy.ts";
import { fetchLiveFeedObject } from "../lib/live_feed_source.ts";
import {
  loadAgentDownline,
  treeDownlineCounts,
  treeSubtreeExposure,
} from "../lib/agent_downline.ts";
import { LIVE_POSITIONS_R2_KEYS } from "../lib/live_positions_r2_publisher.ts";

const REPO = join(import.meta.dir, "..");
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    book: {
      type: "string",
      default: join(REPO, "enriched_customers_full.json"),
    },
    tree: { type: "string", default: join(REPO, "data", "agent-tree.json") },
    downline: {
      type: "string",
      default: join(REPO, "sportsdesk_downline_data.json"),
    },
    out: {
      type: "string",
      default: join(REPO, "data", "customer-profiles.json"),
    },
    json: { type: "boolean", default: false },
    feed: { type: "string", default: "r2" },
  },
});

const bookPath = resolve(values.book ?? "");
const rows = (await Bun.file(bookPath)
  .json()
  .catch((error: unknown) => {
    console.error(
      `customers:profiles: cannot read ${bookPath}: ${String(error)}`,
    );
    process.exit(2);
  })) as CustomerRow[];

// Signal honesty: the book can be sparse or synthetic. Merge observed live profiles from
// reports/harvested-live-profiles.json, and remember which rows came from that model-derived
// artifact so the output can label them instead of passing their numbers off as book measurements.
const harvestedPath = join(REPO, "reports", "harvested-live-profiles.json");
const harvestedIds = new Set<string>();
const harvestedFile = Bun.file(harvestedPath);
if (await harvestedFile.exists()) {
  try {
    const harvested = (await harvestedFile.json()) as { profiles?: unknown[] };
    if (Array.isArray(harvested?.profiles)) {
      const existingIds = new Set(
        rows.map((row) => row.customer_id.trim().toUpperCase()),
      );
      for (const profile of harvested.profiles) {
        const row = customerRowFromHarvestedProfile(profile);
        if (row === null || existingIds.has(row.customer_id)) continue;
        existingIds.add(row.customer_id);
        harvestedIds.add(row.customer_id);
        rows.push(row);
      }
    }
  } catch {
    // signal honesty: an unreadable harvested artifact adds no rows
  }
}

// Every customer that appears in either live capture, independent of the ranked harvest.
// A wager must reach a profile even when the customer is not in the book or the flagged top-N.
const liveFeedProvenance: Record<string, unknown> = {};
async function loadLiveArtifact(
  label: "liveWagers" | "liveBets",
  key: string,
  localPath: string,
): Promise<unknown> {
  if (values.feed !== "local") {
    try {
      const object = await fetchLiveFeedObject(key);
      liveFeedProvenance[label] = {
        source: "r2",
        key: object.key,
        url: object.url,
        observedAt: object.observedAtIso,
        fetchedAt: object.fetchedAtIso,
        bytes: object.bytes,
      };
      return object.doc;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const local = await Bun.file(localPath)
        .json()
        .catch(() => null);
      liveFeedProvenance[label] = {
        source: "local-fallback",
        key,
        localPath: localPath.replace(REPO, "."),
        error: message,
      };
      return local;
    }
  }
  const local = await Bun.file(localPath)
    .json()
    .catch(() => null);
  liveFeedProvenance[label] = {
    source: "local",
    localPath: localPath.replace(REPO, "."),
  };
  return local;
}

const liveWagersDoc = await loadLiveArtifact(
  "liveWagers",
  LIVE_POSITIONS_R2_KEYS.liveWagers,
  join(REPO, "data", "live-wagers.json"),
);
const liveBetsDoc = await loadLiveArtifact(
  "liveBets",
  LIVE_POSITIONS_R2_KEYS.liveBets,
  join(REPO, "data", "live-bets.json"),
);
const writerExclusions = { alert: 0, blocked: 0 };
for (const row of liveWagerRows(liveWagersDoc)) {
  const disposition = ticketWriterDisposition(row.TicketWriter);
  if (disposition === "alert") writerExclusions.alert++;
  else if (disposition === "blocked") writerExclusions.blocked++;
}
const liveRows = customerRowsFromLiveCaptures(liveWagersDoc, liveBetsDoc);
const positionRefusals = { nullTicket: 0, nullWager: 0 };
const rowById = new Map(
  rows.map((row) => [row.customer_id.trim().toUpperCase(), row]),
);
for (const live of liveRows) {
  const existing = rowById.get(live.customer_id);
  if (existing === undefined) {
    rows.push(live);
    rowById.set(live.customer_id, live);
    continue;
  }
  const positions = [...(existing.open_positions ?? [])];
  const seen = new Set(
    positions
      .map((position) => positionIdentity(position).key)
      .filter((key): key is string => key !== null),
  );
  for (const position of live.open_positions ?? []) {
    const identity = positionIdentity(position);
    if (identity.key === null) {
      if (identity.refusal === "null_ticket") positionRefusals.nullTicket++;
      else positionRefusals.nullWager++;
      continue;
    }
    if (seen.has(identity.key)) continue;
    seen.add(identity.key);
    positions.push(position);
  }
  const recentTickets = existing.recent_tickets ?? live.recent_tickets;
  const merged = {
    ...existing,
    ...(existing.agent_id === undefined && live.agent_id !== undefined
      ? { agent_id: live.agent_id }
      : {}),
    ...(recentTickets === undefined ? {} : { recent_tickets: recentTickets }),
    ...(positions.length === 0 ? {} : { open_positions: positions }),
  };
  rows[rows.indexOf(existing)] = merged;
  rowById.set(live.customer_id, merged);
}

const tree = (await Bun.file(resolve(values.tree ?? "")).json()) as TreeIndex;
const { profiles, summary } = buildCustomerProfiles(rows, tree);

// Harvested rows are model-derived and the artifact publishes no lifetime volume, so their profiles
// carry a source flag: an absent aggregate must not read as a measured zero.
const labelledProfiles = profiles.map((profile) =>
  harvestedIds.has(profile.customerId.toUpperCase())
    ? {
        ...profile,
        flags: [
          ...profile.flags,
          "SOURCE:harvested-live-profiles (model-derived; lifetime volume not measured)",
        ],
      }
    : profile,
);

const downlinePath = resolve(values.downline ?? "");
const downline = await loadAgentDownline(downlinePath);
const agentIds = new Set(
  labelledProfiles
    .map((profile) => profile.agentId.trim().toUpperCase())
    .filter((agent) => agent !== "" && agent !== "UNASSIGNED"),
);
const treeExposure = treeSubtreeExposure(tree.nodes, labelledProfiles);
for (const agent of treeExposure.keys()) agentIds.add(agent);
const treeCounts = treeDownlineCounts(tree.nodes, agentIds);
let downlineMatched = 0;
const enrichedProfiles = labelledProfiles.map((profile) => {
  const agent = profile.agentId.trim().toUpperCase();
  const rollup = downline?.byAgent.get(agent);
  const counts = treeCounts.get(agent);
  const exposure = treeExposure.get(agent);
  if (rollup !== undefined) downlineMatched++;
  return {
    ...profile,
    ...(rollup === undefined ? {} : { downline: rollup }),
    ...(counts === undefined ? {} : { treeDownline: counts }),
    ...(exposure === undefined ? {} : { treeExposure: exposure }),
  };
});

const outPath = resolve(values.out ?? "");
await Bun.write(
  outPath,
  JSON.stringify(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      source: {
        book: bookPath.replace(REPO, "."),
        liveFeed: liveFeedProvenance,
        tree: resolve(values.tree ?? "").replace(REPO, "."),
        ...(harvestedIds.size === 0
          ? {}
          : { harvestedProfiles: harvestedPath.replace(REPO, ".") }),
      },
      window:
        "recent-sample (5 tickets per customer); lifetime numbers come from the book",
      liveProxy: "GSLIVE channel — unverified as a live-betting flag",
      summary,
      positionRefusals,
      writerExclusions,
      agentExposureTop: [...treeExposure.entries()]
        .sort((a, b) => b[1].openRiskUsd - a[1].openRiskUsd)
        .slice(0, 20)
        .map(([agent, exposure]) => ({
          agent,
          ...exposure,
          ...(treeCounts.get(agent) ?? {}),
        })),
      downline: {
        status: downline === null ? "missing" : "ok",
        source: downlinePath.replace(REPO, "."),
        agents: downline?.agents ?? null,
        matched: downlineMatched,
        meta: downline?.meta ?? null,
        note: "sportsdesk_downline_data.json is a point-in-time fixture, not a live feed",
      },
      profiles: enrichedProfiles,
    },
    null,
    2,
  ),
);

if (values.json) {
  console.log(JSON.stringify({ summary, profiles: enrichedProfiles }, null, 2));
} else {
  // The book's `*_usd` fields are dollars (a $20,000 ticket is `risk_usd: 20000`), not cents.
  const usd = (dollars: number) =>
    `${dollars < 0 ? "-" : ""}$${Math.abs(Math.round(dollars)).toLocaleString("en-US")}`;
  console.log(
    `customers:profiles: ${summary.customers} customer(s), ${summary.tickets} ticket(s)`,
  );
  console.log(`  wrote ${outPath.replace(REPO, ".")}`);
  console.log(
    `  lifetime net ${usd(summary.lifetimeNetUsd)} · sample net ${usd(summary.sampleNetUsd)} on ${usd(summary.sampleRiskUsd)} risk`,
  );
  console.log(`\n  by league (sample):`);
  for (const [league, bucket] of Object.entries(summary.byLeague).sort(
    (a, b) => b[1].n - a[1].n,
  )) {
    console.log(
      `    ${league.padEnd(5)} ${String(bucket.n).padStart(4)} tickets  net ${usd(bucket.netUsd)}`,
    );
  }
  console.log(`\n  by market (sample):`);
  for (const [market, bucket] of Object.entries(summary.byMarket).sort(
    (a, b) => b[1].n - a[1].n,
  )) {
    console.log(
      `    ${market.padEnd(10)} ${String(bucket.n).padStart(4)} tickets  net ${usd(bucket.netUsd)}`,
    );
  }
  console.log(`\n  by channel (sample; GSLIVE is the live proxy):`);
  for (const [channel, bucket] of Object.entries(summary.byChannel).sort(
    (a, b) => b[1].n - a[1].n,
  )) {
    console.log(
      `    ${channel.padEnd(10)} ${String(bucket.n).padStart(4)} tickets  net ${usd(bucket.netUsd)}`,
    );
  }
  console.log(`\n  sharpest (sharp_score, clv_bps):`);
  for (const entry of summary.sharpest) {
    console.log(
      `    ${entry.customerId.padEnd(10)} ${String(entry.sharpScore).padStart(5)}  ${entry.clvBps} bps`,
    );
  }
  console.log(`\n  worst recent sample net:`);
  for (const entry of summary.worstRecent) {
    console.log(`    ${entry.customerId.padEnd(10)} ${usd(entry.netUsd)}`);
  }
  if (summary.notInTree.length > 0) {
    console.log(`\n  agents not in the tree: ${summary.notInTree.join(", ")}`);
  }
}
