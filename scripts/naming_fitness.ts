#!/usr/bin/env bun
// ============================================================================
// naming_fitness.ts — the five guarantees from the migration plan, executable.
//
// Each check is named after the guarantee it enforces, prints its counterexample
// when it fails, and the process exits 1 if ANY guarantee is violated. The point
// is a gate that FAILS on the current state and passes after the renames; a green
// run today would mean the checks are wrong.
//
//   bun scripts/naming_fitness.ts          human output, exit 0/1
//   bun scripts/naming_fitness.ts --json   machine output
//
// CI wiring: run this in the release gate after the rename sequence lands. It is
// not part of `bun test` because it is expected to fail until then, and a
// permanently red unit suite trains people to ignore it.
// ============================================================================
import {
  ORIGIN_DOMAIN_REGISTRY,
  VENUE_REGISTRY,
  WRITER_LANE_REGISTRY,
  type OriginDomainId,
  type VenueId,
  type WriterLaneId,
} from "../lib/domain_venue_registry.ts";
import { F402_BET_TICKER_SENTINEL_CHANNELS } from "../lib/f402_bet_ticker_delta.ts";
import { IDENTIFIER_GRAMMAR, RESERVED_SENTINEL_WORDS, matchesGrammar } from "../lib/identifier_grammar.ts";

const venueIds = Object.keys(VENUE_REGISTRY) as VenueId[];
const originIds = Object.keys(ORIGIN_DOMAIN_REGISTRY) as OriginDomainId[];
const laneIds = Object.keys(WRITER_LANE_REGISTRY) as WriterLaneId[];
const rowFlags = [...F402_BET_TICKER_SENTINEL_CHANNELS];

interface Check {
  readonly guarantee: string;
  readonly rule: string;
  run(): string[];
}

const checks: readonly Check[] = [
  {
    guarantee: "noLaneIdIsARowFlag",
    rule: "a lane id never spells a row flag, case-insensitively",
    run: () =>
      laneIds.filter((lane) =>
        rowFlags.some((flag) => flag.toLowerCase() === lane.toLowerCase()),
      ),
  },
  {
    guarantee: "everyVenueHasOneKindAndOneOrigin",
    rule: "each venue has exactly one kind and exactly one origin",
    run: () =>
      venueIds
        .filter((id) => VENUE_REGISTRY[id].originDomainIds.length !== 1)
        .map((id) => `${id}: ${VENUE_REGISTRY[id].originDomainIds.length} origins`),
  },
  {
    guarantee: "laneIdMatchesProvenanceLabel",
    rule: "each lane's provenance label is its id in UPPER_SNAKE",
    run: () =>
      laneIds
        .filter((lane) => WRITER_LANE_REGISTRY[lane].provenanceLabel !== lane.toUpperCase())
        .map((lane) => `${lane} -> "${WRITER_LANE_REGISTRY[lane].provenanceLabel}"`),
  },
  {
    guarantee: "sentinelsAreNotWritableFeeds",
    rule: "no venue id or lane id is a reserved sentinel word",
    run: () => [
      ...venueIds.filter((id) => RESERVED_SENTINEL_WORDS.includes(id)).map((id) => `venue ${id}`),
      ...laneIds.filter((id) => RESERVED_SENTINEL_WORDS.includes(id)).map((id) => `lane ${id}`),
    ],
  },
  {
    guarantee: "everyOriginHasTokenMatchedLane",
    rule: "each origin's default token is worn by a lane on that origin",
    run: () =>
      originIds.filter((origin) => {
        const token = ORIGIN_DOMAIN_REGISTRY[origin].defaultTokenCode;
        return !laneIds.some(
          (lane) =>
            WRITER_LANE_REGISTRY[lane].originDomainId === origin &&
            WRITER_LANE_REGISTRY[lane].tokenProvenanceCode === token,
        );
      }),
  },
  {
    guarantee: "identifiersMatchTheirCasingRule",
    rule: "every declared id matches the grammar for its kind",
    run: () => {
      const violations: string[] = [];
      for (const id of venueIds) if (!matchesGrammar("venue", id)) violations.push(`venue ${id}`);
      for (const id of originIds) if (!matchesGrammar("origin", id)) violations.push(`origin ${id}`);
      for (const id of laneIds) if (!matchesGrammar("lane", id)) violations.push(`lane ${id}`);
      for (const flag of rowFlags) if (!matchesGrammar("rowFlag", flag)) violations.push(`rowFlag ${flag}`);
      for (const lane of laneIds) {
        const label = WRITER_LANE_REGISTRY[lane].provenanceLabel;
        if (!matchesGrammar("provenanceLabel", label)) violations.push(`provenanceLabel "${label}" (lane ${lane})`);
      }
      return violations;
    },
  },
];

const results = checks.map((check) => ({ guarantee: check.guarantee, rule: check.rule, violations: check.run() }));
const failed = results.filter((r) => r.violations.length > 0);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2));
} else {
  for (const result of results) {
    const status = result.violations.length === 0 ? "PASS" : "FAIL";
    console.log(`${status}  ${result.guarantee}`);
    console.log(`      ${result.rule}`);
    for (const violation of result.violations) console.log(`      - ${violation}`);
  }
  console.log(
    failed.length === 0
      ? "\nall guarantees hold"
      : `\n${failed.length}/${results.length} guarantees violated — this is the pre-refactor state`,
  );
}
// Grammar reference is exported so the gate and the contract layer cannot drift.
if (Object.keys(IDENTIFIER_GRAMMAR).length !== 6) {
  console.error("identifier grammar does not declare all six identifier kinds");
  process.exit(2);
}
process.exit(failed.length === 0 ? 0 : 1);
