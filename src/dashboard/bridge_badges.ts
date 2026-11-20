/**
 * @file src/dashboard/bridge_badges.ts
 * @description Provenance badges for the two live desk bridges, derived from the
 * transport-bridge specification table rather than restated beside it.
 *
 * The badge carries no colour: presentation colour is a token-layer concern
 * (`design/tokens.toml` / `src/dashboard/tokens.generated.css`), and there is no
 * per-bridge palette entry today. Shipping a hex literal here would create a
 * second, ungenerated colour source that `gen:tokens:gate` cannot see.
 */

import type { DurationMilliseconds } from "../../design/domain-branded-types.ts";
import {
  TRANSPORT_BRIDGE_SPECIFICATION_TABLE,
  type TransportBridgeId,
  type TransportOriginDomain,
  type WebSocketSubscriptionTopic,
} from "../../lib/bridge_and_channel_router.ts";

export interface BridgeStatusBadge {
  readonly bridgeId: TransportBridgeId;
  readonly label: string;
  readonly originDomain: TransportOriginDomain;
  readonly topic: WebSocketSubscriptionTopic;
  readonly freshnessSlaMs: DurationMilliseconds;
}

function badge(bridgeId: TransportBridgeId, label: string): BridgeStatusBadge {
  const specification = TRANSPORT_BRIDGE_SPECIFICATION_TABLE[bridgeId];
  return {
    bridgeId,
    label,
    originDomain: specification.originDomain,
    topic: specification.webSocketSubscriptionTopic,
    freshnessSlaMs: specification.freshnessSlaDurationMs,
  };
}

export const BRIDGE_STATUS_BADGES = [
  badge("BRIDGE_01_F402_BET_TICKER_STREAM", "F402 Bet Ticker"),
  badge("BRIDGE_03_GSLIVE_PARTNER118_TALLY", "P118 GSLive Tally"),
] as const satisfies readonly BridgeStatusBadge[];
