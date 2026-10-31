import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  TEN_MODE_CATALOG,
  evaluateMode1CustomerOverview,
  evaluateMode2AccessLogs,
  evaluateMode3SharedIpOverview,
  evaluateMode4CustomerIpHistory,
  evaluateMode5AccountsByIp,
  evaluateMode6ActivityOverlap,
  evaluateMode7WagerComparison,
  evaluateMode8SettledNet,
  evaluateMode9PendingExposure,
  evaluateMode10Reconciliation,
  computeEffectiveLineHundredths,
  buildTenModeLiveSnapshot,
} from "../lib/forensic_diagnostic_modes.ts";

describe("10-Mode Forensic, Risk, Cross-Market & Data Integrity Engine", () => {
  test("test_catalog_defines_all_10_modes_across_4_domains", () => {
    assert.equal(TEN_MODE_CATALOG.length, 10);
    const numbers = TEN_MODE_CATALOG.map((m) => m.modeNumber);
    assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    const domains = new Set(TEN_MODE_CATALOG.map((m) => m.domain));
    assert.equal(domains.has("Identity & Network"), true);
    assert.equal(domains.has("Risk & Exposure"), true);
    assert.equal(domains.has("Cross-Market"), true);
    assert.equal(domains.has("Data Integrity"), true);
  });

  test("test_mode_1_customer_overview_validates_net_pending_and_freshness_warnings", () => {
    const fresh = evaluateMode1CustomerOverview({
      customerId: " mj102 ",
      officeAgentId: "mj2026",
      polymarketWallet: "0x07db5765beba17be154cbfbd6324a15f3c81fa4f",
      validatedNetCents: 4285000,
      pendingStakeCents: 6060000,
      pendingDefinedLiabilityCents: 6412000,
      lastAccessUtc: "2026-10-31T17:32:10Z",
      referenceNowMs: Date.parse("2026-10-31T17:37:20Z"),
      hasCompleteLedgerScope: true,
      hasWebLogCoverage: true,
    });
    assert.equal(fresh.mode, 1);
    assert.equal(fresh.customerId, "MJ102");
    assert.equal(fresh.gsLivePlayerId, "player_MJ102");
    assert.equal(fresh.isAccessFresh, true);
    assert.equal(fresh.accessFreshnessSeconds, 310);
    assert.equal(fresh.missingDataWarnings.length, 0);

    const stale = evaluateMode1CustomerOverview({
      customerId: "CHURN_059",
      officeAgentId: "LAKERS",
      validatedNetCents: 1940000,
      pendingStakeCents: 1800000,
      pendingDefinedLiabilityCents: 4320000,
      lastAccessUtc: null,
      hasCompleteLedgerScope: false,
      hasWebLogCoverage: false,
    });
    assert.equal(stale.isAccessFresh, false);
    assert.equal(stale.missingDataWarnings.includes("MISSING_ACCESS_TIMESTAMP_IN_WEBLOG"), true);
    assert.equal(stale.missingDataWarnings.includes("INCOMPLETE_LEDGER_TRANSACTION_WINDOW"), true);
    assert.equal(stale.missingDataWarnings.includes("WEBLOG_MODE_A_COLLECTION_GAP"), true);
  });

  test("test_mode_2_access_logs_distinguishes_self_player_actor_from_office_agent_override", () => {
    const res = evaluateMode2AccessLogs("MJ102", [
      {
        LoginID: "MJ102",
        ActorID: "MJ102",
        AccessDateTime: "2026-10-31T14:42:07Z",
        IPAddress: "104.28.34.12",
        Operation: "LOGIN_AUTH",
        Data: "Widget=player_MJ102",
        nextWagerDwellSeconds: 4.2,
      },
      {
        LoginID: "MJ102",
        ActorID: "MJ2026",
        AccessDateTime: "2026-10-31T14:42:18Z",
        IPAddress: "172.56.21.89",
        Operation: "UPDATE_BY_COLUMN",
        Data: "MaxBet=1000; Delay=6",
      },
    ]);
    assert.equal(res.mode, 2);
    assert.equal(res.totalEvents, 2);
    assert.equal(res.distinctActorsCount, 2);
    assert.equal(res.events[0]!.actorRole, "SELF_PLAYER");
    assert.equal(res.events[0]!.isActorDistinctFromTarget, false);
    assert.equal(res.events[1]!.actorRole, "OFFICE_AGENT");
    assert.equal(res.events[1]!.isActorDistinctFromTarget, true);
  });

  test("test_mode_3_shared_ip_overview_groups_normalized_ips_and_distinct_customers", () => {
    const res = evaluateMode3SharedIpOverview({
      dateWindowStartMdy: "2026-10-25",
      dateWindowEndMdy: "2026-10-31",
      officeFilter: "CUB22HR",
    });
    assert.equal(res.mode, 3);
    assert.equal(res.dateWindowStartMdy, "10/25/2026");
    assert.equal(res.totalAccountGroups, 1);
    const grp = res.groups[0]!;
    assert.equal(grp.normalizedIp, "104.28.55.19");
    assert.equal(grp.subnetCidr, "104.28.55.0/24");
    assert.equal(grp.scope, "CROSS_OFFICE_GLOBAL");
    assert.equal(grp.distinctCustomerCount, 8);
  });

  test("test_mode_4_customer_ip_history_tracks_ip_changes_and_collection_gaps", () => {
    const res = evaluateMode4CustomerIpHistory({
      customerId: "MJ102",
      officeAgentId: "MJ2026",
      startDateYmd: "10/25/2026",
      endDateYmd: "10/31/2026",
      observations: [
        {
          ipAddress: "104.28.34.12",
          asnLabel: "Cloudflare WARP",
          firstSeenUtc: "2026-10-25T12:00:00Z",
          lastSeenUtc: "2026-10-27T12:00:00Z",
          observationCount: 15,
        },
        {
          ipAddress: "172.56.21.89",
          asnLabel: "T-Mobile USA",
          firstSeenUtc: "2026-10-29T00:00:00Z",
          lastSeenUtc: "2026-10-30T12:00:00Z",
          observationCount: 9,
        },
      ],
      collectionGapThresholdHours: 24,
    });
    assert.equal(res.mode, 4);
    assert.equal(res.wireQueryParam.includes('start="2026-10-25"'), true);
    assert.equal(res.ipChangeCount, 1);
    assert.equal(res.collectionGapsCount, 1);
    assert.equal(res.ipTimeline[1]!.gapBeforeSpanHours, 36);
    assert.equal(res.ipTimeline[1]!.hasCollectionGapWarning, true);
  });

  test("test_mode_5_accounts_by_ip_lists_observed_accounts_and_timestamps", () => {
    const res = evaluateMode5AccountsByIp({
      selectedIp: "104.28.34.12 (104.28.34.0/24)",
      accounts: [
        {
          accountId: "MJ102",
          officeAgentId: "MJ2026",
          firstTimestampUtc: "2026-10-25T12:00:00Z",
          lastTimestampUtc: "2026-10-31T17:32:10Z",
          totalHitsOnIp: 27,
          operationsObserved: ["LOGIN_AUTH", "PLACE_WAGER"],
        },
        {
          accountId: "MJ103",
          officeAgentId: "MJ2026",
          firstTimestampUtc: "2026-10-26T15:11:00Z",
          lastTimestampUtc: "2026-10-31T17:32:13Z",
          totalHitsOnIp: 18,
          operationsObserved: ["LOGIN_AUTH", "PLACE_WAGER"],
        },
      ],
    });
    assert.equal(res.mode, 5);
    assert.equal(res.selectedIp, "104.28.34.12");
    assert.equal(res.observedAccountCount, 2);
    assert.equal(res.accounts[0]!.gsLivePlayerId, "player_MJ102");
  });

  test("test_mode_6_activity_overlap_distinguishes_concurrent_sessions_from_nearby_events", () => {
    const sessionOverlap = evaluateMode6ActivityOverlap(
      {
        accountId: "MJ102",
        officeAgentId: "MJ2026",
        windowKind: "BOUNDED_SESSION_INTERVAL",
        startUtc: "2026-10-31T14:40:00Z",
        endUtc: "2026-10-31T14:45:00Z",
        ipAddress: "104.28.34.12",
        actionSummary: "Session A",
      },
      {
        accountId: "MJ103",
        officeAgentId: "MJ2026",
        windowKind: "BOUNDED_SESSION_INTERVAL",
        startUtc: "2026-10-31T14:42:00Z",
        endUtc: "2026-10-31T14:46:00Z",
        ipAddress: "104.28.34.12",
        actionSummary: "Session B",
      }
    );
    assert.equal(sessionOverlap.overlapDurationSeconds, 180);
    assert.equal(sessionOverlap.distinctionVerdict, "CONFIRMED_CONCURRENT_SESSION_OVERLAP");

    const nearbyPointEvents = evaluateMode6ActivityOverlap(
      {
        accountId: "CHURN_059",
        officeAgentId: "LAKERS",
        windowKind: "POINT_IN_TIME_EVENT_WINDOW",
        startUtc: "2026-10-31T15:22:48Z",
        endUtc: "2026-10-31T15:22:48Z",
        ipAddress: "192.168.9.42",
        actionSummary: "Point Event A",
      },
      {
        accountId: "CHURN_049",
        officeAgentId: "SOUTHSHORE",
        windowKind: "POINT_IN_TIME_EVENT_WINDOW",
        startUtc: "2026-10-31T15:23:12Z",
        endUtc: "2026-10-31T15:23:12Z",
        ipAddress: "192.168.9.42",
        actionSummary: "Point Event B",
      }
    );
    assert.equal(nearbyPointEvents.overlapDurationSeconds, 0);
    assert.equal(nearbyPointEvents.gapBetweenWindowsSeconds, 24);
    assert.equal(nearbyPointEvents.distinctionVerdict, "NEARBY_POINT_EVENTS_WITHOUT_SESSION_OVERLAP");
  });

  test("test_mode_7_wager_comparison_handles_teaser_math_and_dgs_5000_alt_rotations", () => {
    assert.equal(
      computeEffectiveLineHundredths({
        marketType: "TOTAL",
        side: "OVER",
        adjLinePoints: 48.5,
        teaserPoints: 6,
      }),
      4250
    );
    assert.equal(
      computeEffectiveLineHundredths({
        marketType: "TOTAL",
        side: "UNDER",
        adjLinePoints: 48.5,
        teaserPoints: 6,
      }),
      5450
    );

    const cmp = evaluateMode7WagerComparison(
      {
        venue: "FANTASY402",
        ticketOrOrderId: "F402-901002-ALT",
        accountOrWalletId: "BGD101",
        eventDateYmd: "2026-10-31",
        rotationNumber: 5501,
        marketType: "SPREAD",
        period: "FG",
        side: "LAL",
        adjLinePoints: -7.5,
        oddsAmerican: 165,
        stakeCents: 2400000,
        placedAtUtc: "2026-10-31T15:21:10Z",
      },
      {
        venue: "POLYMARKET",
        ticketOrOrderId: "PM-CLOB-LAL",
        accountOrWalletId: "0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612",
        eventDateYmd: "2026-10-31",
        rotationNumber: 501,
        marketType: "SPREAD",
        period: "FG",
        side: "LAL",
        adjLinePoints: -7.5,
        oddsAmerican: 172,
        stakeCents: 2400000,
        placedAtUtc: "2026-10-31T15:21:06Z",
      }
    );
    assert.equal(cmp.isComparableMatch, true);
    assert.equal(cmp.parentRotationNumber, 501);
    assert.equal(cmp.lineDeltaHundredths, 0);
    assert.equal(cmp.matchReasons.includes("NORMALIZED_DGS_ALT_ROT_5501_TO_501"), true);
  });

  test("test_mode_8_settled_net_applies_free_play_zero_loss_principal_and_adjustments", () => {
    const res = evaluateMode8SettledNet({
      customerId: "MJ102",
      tickets: [
        {
          ticketKey: "100-1",
          periodBucket: "7D",
          currency: "USD",
          wagerStatus: "W",
          amountWageredCents: 110000,
          toWinAmountCents: 100000,
          freePlayFlag: "N",
        },
        {
          ticketKey: "101-1",
          periodBucket: "7D",
          currency: "USD",
          wagerStatus: "L",
          amountWageredCents: 50000,
          toWinAmountCents: 45450,
          freePlayFlag: "Y",
        },
      ],
      adjustments: [
        {
          adjustmentId: "ADJ-1",
          periodBucket: "7D",
          currency: "USD",
          signedAmountCents: -10000,
          reason: "Fee",
        },
      ],
    });
    assert.equal(res.grossWonCents, 100000);
    assert.equal(res.grossLostCents, 0);
    assert.equal(res.freePlayLostPrincipalSavedCents, 50000);
    assert.equal(res.customerNetProfitLossCents, 90000);
    assert.equal(res.bookNetHoldCents, -100000);
  });

  test("test_mode_9_pending_exposure_deduplicates_ticket_wager_keys_and_separates_stake_payout_liability", () => {
    const res = evaluateMode9PendingExposure("MJ102", [
      {
        TicketNumber: 901104,
        WagerNumber: 1,
        WagerType: "P",
        AmountWagered: 100000,
        ToWinAmount: 260000,
        FreePlayFlag: "N",
        WagerStatus: "P",
        TicketWriter: "Internet",
        Description: "Leg 1",
      },
      {
        TicketNumber: 901104,
        WagerNumber: 1,
        WagerType: "P",
        AmountWagered: 100000,
        ToWinAmount: 260000,
        FreePlayFlag: "N",
        WagerStatus: "P",
        TicketWriter: "Internet",
        Description: "Leg 2",
      },
      {
        TicketNumber: 901105,
        WagerNumber: 1,
        WagerType: "S",
        AmountWagered: 50000,
        ToWinAmount: 45450,
        FreePlayFlag: "Y",
        WagerStatus: "P",
        TicketWriter: "Internet",
        Description: "Free Play Straight",
      },
      {
        TicketNumber: 901106,
        WagerNumber: 1,
        WagerType: "S",
        AmountWagered: 100000,
        ToWinAmount: 90900,
        FreePlayFlag: "N",
        WagerStatus: "P",
        TicketWriter: "ALERT",
        Description: "ALERT duplicate mirror",
      },
    ]);
    assert.equal(res.uniquePendingTicketsCount, 2);
    assert.equal(res.droppedNoiseOrAlertRowsCount, 1);
    assert.equal(res.totalStakeCents, 100000);
    assert.equal(res.definedLiabilityCents, 305450);
    assert.equal(res.potentialPayoutCents, 405450);
  });

  test("test_mode_10_reconciliation_identifies_explained_differences_and_unresolved_gaps", () => {
    const exactWithDiff = evaluateMode10Reconciliation({
      customerId: "MJ102",
      scopeWindow: "2026-10-25..2026-10-31",
      isIdenticalScopeVerified: true,
      reportDailyFiguresTotalCents: 2454500,
      settledTicketsSumCents: 2454500,
      ledgerTransactionsDeltaCents: 2304500,
      explainedDifferences: [
        {
          category: "MANUAL_LEDGER_ADJUSTMENT",
          amountCents: -150000,
          explanation: "Wire fee",
        },
      ],
    });
    assert.equal(exactWithDiff.unresolvedGapCents, 0);
    assert.equal(exactWithDiff.reconciliationStatus, "RECONCILED_WITH_EXPLAINED_DIFFS");

    const gapAlert = evaluateMode10Reconciliation({
      customerId: "MJ102",
      scopeWindow: "2026-10-25..2026-10-31",
      isIdenticalScopeVerified: true,
      reportDailyFiguresTotalCents: 2454500,
      settledTicketsSumCents: 2454500,
      ledgerTransactionsDeltaCents: 2000000,
      explainedDifferences: [],
    });
    assert.equal(gapAlert.unresolvedGapCents, -454500);
    assert.equal(gapAlert.reconciliationStatus, "UNRESOLVED_GAP_ALERT");

    const snap = buildTenModeLiveSnapshot();
    assert.equal(snap.catalog.length, 10);
  });
});
