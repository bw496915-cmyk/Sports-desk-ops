import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  formatGsLivePlayerToken,
  computeCdtDayStartEpochSeconds,
  buildGsLiveUsersReportDeepLink,
  buildGsLiveBetHistorySidecarUrl,
  buildGsLiveDualSurfaceDescriptor,
} from "../lib/gslive_manager_deeplink_sidecar.ts";

describe("GSLive Manager 7-Param Deep-Link Builder & Live Bet-History Sidecar", () => {
  test("test_build_users_report_deeplink_matches_exact_7_param_churn_003_contract", () => {
    const url = buildGsLiveUsersReportDeepLink({
      customerLogin: "CHURN_003",
      bot: true,
      eventId: "",
      fromIsoUtc: "2026-10-18T05:00:00.000Z",
      toIsoUtc: "2026-10-26T04:59:59.000Z",
      partnerId: 118,
      searchBy: "player",
    });

    assert.equal(
      url,
      "https://plive.sportswidgets.pro/manager-tools/#/reports/users?bot=true&eventId=&from=2026-10-18T05%3A00%3A00.000Z&partnerId=118&searchBy=player&text=player_CHURN_003&to=2026-10-26T04%3A59:59.000Z".replace(
        "04%3A59:59.000Z",
        "04%3A59%3A59.000Z"
      )
    );
  });

  test("test_build_bet_history_sidecar_url_matches_exact_epoch_and_calctime_contract", () => {
    assert.equal(computeCdtDayStartEpochSeconds("2026-10-31"), 1793422800);

    const sidecarUrl = buildGsLiveBetHistorySidecarUrl({
      minVolume: 0,
      maxTimeUntilScore: 0,
      fromEpochSec: 1793422800,
      toEpochSec: 1793422800,
      toTimeSec: 86399,
      dateFilterBy: "calcTime",
      tickEpochMs: 1793469958152,
    });

    assert.equal(
      sidecarUrl,
      "https://plive.sportswidgets.pro/manager-tools/#/events/bet-history?minVolume=0&maxTimeUntilScore=0&from=1793422800&to=1793422800&toTime=86399&dateFilterBy=calcTime&t=1793469958152"
    );
  });

  test("test_dual_surface_descriptor_generates_both_report_deeplinks_and_live_sidecar_urls", () => {
    assert.equal(formatGsLivePlayerToken(" player_mj102 "), "player_MJ102");
    const desc = buildGsLiveDualSurfaceDescriptor("CHURN_003", {
      dateYmd: "2026-10-31",
      tickEpochMs: 1793469958152,
    });

    assert.equal(desc.gsLivePlayerId, "player_CHURN_003");
    assert.equal(desc.usersReportChurnWindowDeepLink.includes("bot=true"), true);
    assert.equal(desc.usersReportChurnWindowDeepLink.includes("text=player_CHURN_003"), true);
    assert.equal(desc.liveBetHistorySidecarCalcTimeUrl.includes("dateFilterBy=calcTime"), true);
    assert.equal(desc.liveBetHistorySidecarBetTimeUrl.includes("dateFilterBy=betTime"), true);
    assert.equal(desc.getBetReportObservedPayload.from, 1793422800);
    assert.equal(desc.getBetReportObservedPayload.toTime, 86399);
  });
});
