/**
 * @file scripts/ppm_live_snapshot.ts
 * @description Fetches the PPM player-site fixture snapshot and prints a
 * normalized summary. This is the ingestion half of the PPM mapping: the
 * parser in `lib/ppm_live_feed.ts` stays pure, so the same bytes can be
 * replayed in tests.
 *
 *   bun scripts/ppm_live_snapshot.ts
 *   bun scripts/ppm_live_snapshot.ts --out scratch/ppm/all-events.json
 *
 * The site issues a `GSID` session cookie on the page load; `/live/allEvents`
 * answers without credentials once that cookie is present. Nothing here writes
 * to the repository: the default output is stdout.
 */
import { parsePpmAllEvents } from "../lib/ppm_live_feed.ts";

const BASE = Bun.env.PPM_BASE_URL ?? "https://ppm.sportswidgets.pro/live";

function parseOutputPath(argv: readonly string[]): string | null {
  const index = argv.indexOf("--out");
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value) throw new Error("--out requires a path");
  return value;
}

async function sessionCookie(): Promise<string> {
  const page = await fetch(`${BASE}/`, {
    headers: { "user-agent": "sportsdesk-ops/ppm-snapshot" },
  });
  if (!page.ok) {
    throw new Error(`page load failed: HTTP ${page.status}`);
  }
  const cookies = page.headers.getSetCookie();
  const gsid = cookies.find((cookie) => cookie.startsWith("GSID="));
  if (!gsid) throw new Error("no GSID cookie on the page response");
  return gsid.split(";")[0]!;
}

async function main(): Promise<void> {
  const cookie = await sessionCookie();
  const response = await fetch(`${BASE}/allEvents`, {
    headers: { cookie, accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`allEvents failed: HTTP ${response.status}`);
  }
  const snapshot = parsePpmAllEvents(await response.json());

  const summary = {
    base: BASE,
    counts: snapshot.counts,
    sports: snapshot.sportIds.length,
    leagues: snapshot.leagues.length,
    nextFixtures: snapshot.fixtures.slice(0, 5).map((fixture) => ({
      eventId: fixture.eventId,
      sportId: fixture.sportId,
      leagueId: fixture.leagueId,
      home: fixture.home.name,
      away: fixture.away.name,
      startsAt: new Date(fixture.startTimeUnix * 1000).toISOString(),
    })),
  };

  const out = parseOutputPath(process.argv);
  if (out) {
    await Bun.write(out, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(JSON.stringify({ ...summary, writtenTo: out }, null, 2));
    return;
  }
  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.main) {
  await main();
}
