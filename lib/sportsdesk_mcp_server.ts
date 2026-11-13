/**
 * @file lib/sportsdesk_mcp_server.ts
 * @description Native Bun StreamableHTTP Model Context Protocol (`/mcp`) server and
 * read-only spine toolset for `sportsdesk-ops`.
 *
 * Directly imports the TypeScript spine modules (zero IPC, zero cross-language serialization):
 *  - `get_channel_provenance`: `lib/provenance_palette.ts`, `design/domain-branded-types.ts`, `lib/domain_venue_registry.ts`
 *  - `get_bridge_channel_catalog`: `lib/bridge_and_channel_router.ts`, `lib/nsh_frame_schema.ts`
 *  - `check_sor_slippage`: `lib/execution_decision.ts` + SOR-1 200 bps / NSH u8 frame bounds
 *  - `decode_nsh_frame`: `lib/nsh_frame_codec.ts`, `lib/nsh_frame_schema.ts`
 *
 * Supports both stateful `Mcp-Session-Id` StreamableHTTP sessions (default) and
 * per-request `--stateless` operation, gated by constant-time `SPORTSDESK_ADMIN_TOKEN`
 * Bearer authentication unless explicitly disabled for local CLI inspection.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  INGESTION_CHANNELS,
  isColorHexInt,
  parseAsColorHexInt,
  type ColorHexInt,
  type SignalChannelCode,
} from "../design/domain-branded-types.ts";
import {
  DodGateFailureError,
  NULL_BRIDGE_CHANNEL_WORD32,
  SIGNAL_CHANNEL_POLICY_SPECIFICATION_TABLE,
  TRANSPORT_BRIDGE_SPECIFICATION_TABLE,
  asBitSet32,
  asCents,
  asDurationMilliseconds,
  encodeBridgeChannelPackedWord32,
  isTransportBridgePermittedForChannel,
  resolveSeparatedBridgeAndChannelEnvelope,
  type BridgeChannelPackedWord32,
  type ExtendedSignalChannelCode,
  type RawWireIngestEnvelope,
  type SignalChannelPolicySpecification,
  type TransportBridgeId,
  type TransportBridgeSpecification,
} from "./bridge_and_channel_router.ts";
import {
  ORIGIN_DOMAIN_REGISTRY,
  WRITER_LANE_REGISTRY,
  resolveWriterLaneId,
} from "./domain_venue_registry.ts";
import {
  DEFAULT_SPORT_TIERS,
  policyFromEnv,
  tierForPolicy,
  walkBook,
} from "./execution_decision.ts";
import {
  NSH_FRAME_BYTE_LENGTH,
  NSH_FRAME_MAGIC,
  NSH_FRAME_VERSION,
  NSH_MESSAGE_TYPE,
  NshFrameCodecError,
  readNshBinaryFrame,
} from "./nsh_frame_codec.ts";
import {
  NSH_FRAME_LAYOUT,
  decodeBridgeChannelPackedWord32,
  packChannelHandle32,
  resolveRouteWordChannelAndSla,
  unpackChannelHandle32,
} from "./nsh_frame_schema.ts";
import {
  PROVENANCE_CHANNEL_CODES,
  provenanceCodeForColor,
  provenanceColorFor,
  provenanceCssFor,
  provenanceCssForColor,
} from "./provenance_palette.ts";

export const SPORTSDESK_MCP_SERVER_NAME = "sportsdesk-ops" as const;
export const SPORTSDESK_MCP_SERVER_VERSION = "1.0.0" as const;

/** SOR-1 execution ceiling encoded into the 1-byte `slippageBps8` NSH frame slot. */
export const SOR1_MAX_SLIPPAGE_BPS = 200 as const;
/** Hardware width ceiling of `slippageBps8` at byte offset 61 of the 64-byte NSH frame. */
export const NSH_FRAME_SLIPPAGE_U8_MAX = 255 as const;

const DEFAULT_MAX_MCP_SESSIONS = 256;
/** Stay below Bun.serve's 10s default socket idleTimeout so GET /mcp SSE streams stay alive. */
const DEFAULT_SSE_KEEPALIVE_MS = 8_000;

const MCP_ALLOW_METHODS = "GET, POST, DELETE, OPTIONS";
const MCP_ALLOW_HEADERS =
  "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID, X-Requested-With";
const MCP_EXPOSE_HEADERS = "Mcp-Session-Id, Mcp-Protocol-Version";

const PROVENANCE_CHANNEL_ENUM_VALUES = [
  "Internet",
  "BLOCKED",
  "GATEWAY",
  "ALERT",
  "GSBUILDER",
  "GSLIVE",
  "CSLEVEL2",
] as const satisfies readonly SignalChannelCode[];

const TRANSPORT_BRIDGE_ENUM_VALUES = [
  "BRIDGE_00_GSLIVE_WAGERS_BY_STATE",
  "BRIDGE_01_F402_BET_TICKER_STREAM",
  "BRIDGE_02_F402_PENDING_AND_GRADING",
  "BRIDGE_03_GSLIVE_PARTNER118_TALLY",
  "BRIDGE_04_F402_WEBLOG_ACCESS_OVERLAP",
  "BRIDGE_05_POLYMARKET_GAMMA_DISCOVERY",
  "BRIDGE_06_POLYMARKET_CLOB_WEBSOCKET",
  "BRIDGE_07_POLYGON_FASTLANE_ORDER_FILLED",
  "BRIDGE_08_POLYMARKET_DATA_API_POSITIONS",
  "BRIDGE_09_KALSHI_EXCHANGE_V2_STREAM",
] as const satisfies readonly TransportBridgeId[];

const EXTENDED_CHANNEL_ENUM_VALUES = [
  "NON_SPORTS_DROP",
  "BLOCKED",
  "GATEWAY",
  "ALERT",
  "Internet",
  "GSLIVE",
  "GSBUILDER",
  "LIVE_CWS",
  "CSLEVEL2",
  "PHONE",
  "HOUSE_BOOK",
  "CROSS_VENUE_SHADOW_WALLET_LEAD",
  "CROSS_VENUE_QUARANTINE_SCALP_EXIT",
  "CROSS_VENUE_SYNDICATE_CLUSTER_CONFIRM",
  "CROSS_VENUE_RFQ_COMBO_LAYOFF",
  "CROSS_VENUE_KEY_NUMBER_MIDDLE",
] as const satisfies readonly ExtendedSignalChannelCode[];

const MESSAGE_TYPE_NAMES: Readonly<Record<number, string>> = Object.freeze({
  [NSH_MESSAGE_TYPE.TICKER_MATCH]: "TICKER_MATCH",
  [NSH_MESSAGE_TYPE.LIABILITY_UPDATE]: "LIABILITY_UPDATE",
  [NSH_MESSAGE_TYPE.ORDERBOOK_DELTA]: "ORDERBOOK_DELTA",
});

const ORDERED_BRIDGES: readonly TransportBridgeSpecification[] = Object.freeze(
  Object.values(TRANSPORT_BRIDGE_SPECIFICATION_TABLE).sort(
    (a, b) => a.bridgeOrdinal4 - b.bridgeOrdinal4,
  ),
);

const ORDERED_CHANNELS: readonly SignalChannelPolicySpecification[] =
  Object.freeze(
    Object.values(SIGNAL_CHANNEL_POLICY_SPECIFICATION_TABLE).sort(
      (a, b) => a.channelOrdinal5 - b.channelOrdinal5,
    ),
  );

// ============================================================================
// 1. TOOL SCHEMAS & PURE HANDLERS
// ============================================================================

const PROVENANCE_CHANNEL_ITEM_SCHEMA = z.object({
  channelCode: z.enum(PROVENANCE_CHANNEL_ENUM_VALUES),
  colorHexInt: z.number().int().min(0).max(0xffffff),
  colorCss: z.string(),
  layerId: z.string(),
  tokenName: z.string(),
  signalTier: z.string(),
  transportUri: z.string(),
  slaKind: z.enum(["latency", "sentinel_drop"]),
  slaMs: z.number().int().nullable(),
  channelStatus: z.string(),
  volumeRule: z.string(),
  operationalRole: z.string(),
});

export const GET_CHANNEL_PROVENANCE_INPUT = {
  channelCode: z
    .enum(PROVENANCE_CHANNEL_ENUM_VALUES)
    .optional()
    .describe("Canonical ingestion provenance channel code to inspect"),
  writer: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      "Raw ticket writer or venue alias (for example partner118, inet, polymarket, kalshi)",
    ),
  color: z
    .union([z.string().min(1).max(16), z.number().int().min(0).max(0xffffff)])
    .optional()
    .describe(
      "Packed 24-bit RGB integer (0..16777215) or #RRGGBB / 0xRRGGBB hex string for reverse lookup",
    ),
};

const GET_CHANNEL_PROVENANCE_OUTPUT = {
  channels: z.array(PROVENANCE_CHANNEL_ITEM_SCHEMA),
  matchedChannel: PROVENANCE_CHANNEL_ITEM_SCHEMA.nullable(),
  writerResolution: z
    .object({
      rawWriter: z.string(),
      writerLaneId: z.string(),
      originDomainId: z.string(),
      venueId: z.string(),
      tokenProvenanceCode: z.string(),
      provenanceLabel: z.string(),
      brandColorHex: z.string(),
    })
    .nullable(),
  colorLookup: z
    .object({
      colorHexInt: z.number().int().min(0).max(0xffffff),
      colorCss: z.string(),
      matchedChannelCode: z.enum(PROVENANCE_CHANNEL_ENUM_VALUES).nullable(),
    })
    .nullable(),
  originDomains: z.array(
    z.object({
      originDomainId: z.string(),
      venueId: z.string(),
      displayLabel: z.string(),
      brandColorHex: z.string(),
      defaultTokenCode: z.string(),
    }),
  ),
};

type GetChannelProvenanceInput = z.infer<
  z.ZodObject<typeof GET_CHANNEL_PROVENANCE_INPUT>
>;

function parseColorLookupInput(raw: string | number): ColorHexInt {
  if (typeof raw === "number") {
    if (!isColorHexInt(raw)) {
      throw new RangeError(
        `Color integer must be within 24-bit RGB [0, 0xFFFFFF], got ${String(raw)}`,
      );
    }
    return raw;
  }
  const trimmed = raw.trim();
  if (/^0x[0-9a-fA-F]{1,6}$/i.test(trimmed)) {
    const parsed = Number.parseInt(trimmed.slice(2), 16);
    if (!isColorHexInt(parsed)) {
      throw new RangeError(`Invalid 24-bit hex color literal: ${raw}`);
    }
    return parsed;
  }
  if (/^[0-9a-fA-F]{6}$/.test(trimmed)) {
    return parseAsColorHexInt(`#${trimmed}`);
  }
  return parseAsColorHexInt(trimmed);
}

function serializeProvenanceChannel(
  channel: (typeof INGESTION_CHANNELS)[number],
) {
  return {
    channelCode: channel.channelCode,
    colorHexInt: provenanceColorFor(channel.channelCode) as number,
    colorCss: provenanceCssFor(channel.channelCode),
    layerId: channel.layerId,
    tokenName: channel.tokenName,
    signalTier: channel.signalTier,
    transportUri: channel.transportUri,
    slaKind: channel.sla.kind,
    slaMs: channel.sla.kind === "latency" ? channel.sla.latencySlaMs : null,
    channelStatus: channel.channelStatus,
    volumeRule: channel.volumeRule,
    operationalRole: channel.operationalRole,
  };
}

export function runGetChannelProvenanceTool(
  input: GetChannelProvenanceInput,
): CallToolResult {
  try {
    const allSerialized = INGESTION_CHANNELS.map(serializeProvenanceChannel);
    const filteredChannels =
      input.channelCode !== undefined
        ? allSerialized.filter((c) => c.channelCode === input.channelCode)
        : allSerialized;

    let writerResolution: {
      rawWriter: string;
      writerLaneId: string;
      originDomainId: string;
      venueId: string;
      tokenProvenanceCode: string;
      provenanceLabel: string;
      brandColorHex: string;
    } | null = null;

    if (input.writer !== undefined) {
      const laneId = resolveWriterLaneId(input.writer);
      const lane = WRITER_LANE_REGISTRY[laneId];
      writerResolution = {
        rawWriter: input.writer,
        writerLaneId: lane.writerLaneId,
        originDomainId: lane.originDomainId,
        venueId: lane.venueId,
        tokenProvenanceCode: lane.tokenProvenanceCode,
        provenanceLabel: lane.provenanceLabel,
        brandColorHex: lane.brandColorHex,
      };
    }

    let colorLookup: {
      colorHexInt: number;
      colorCss: string;
      matchedChannelCode: SignalChannelCode | null;
    } | null = null;

    if (input.color !== undefined) {
      const parsedColor = parseColorLookupInput(input.color);
      colorLookup = {
        colorHexInt: parsedColor as number,
        colorCss: provenanceCssForColor(parsedColor),
        matchedChannelCode: provenanceCodeForColor(parsedColor),
      };
    }

    const matchedChannel =
      input.channelCode !== undefined
        ? (allSerialized.find((c) => c.channelCode === input.channelCode) ??
          null)
        : colorLookup?.matchedChannelCode
          ? (allSerialized.find(
              (c) => c.channelCode === colorLookup.matchedChannelCode,
            ) ?? null)
          : writerResolution !== null &&
              PROVENANCE_CHANNEL_CODES.includes(
                writerResolution.provenanceLabel as SignalChannelCode,
              )
            ? (allSerialized.find(
                (c) => c.channelCode === writerResolution.provenanceLabel,
              ) ?? null)
            : null;

    const payload = {
      channels: filteredChannels,
      matchedChannel,
      writerResolution,
      colorLookup,
      originDomains: Object.values(ORIGIN_DOMAIN_REGISTRY).map((entry) => ({
        originDomainId: entry.originDomainId,
        venueId: entry.venueId,
        displayLabel: entry.displayLabel,
        brandColorHex: entry.brandColorHex,
        defaultTokenCode: entry.defaultTokenCode,
      })),
    };

    return {
      structuredContent: payload,
      content: [{ type: "text", text: JSON.stringify(payload) }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: false,
            errorCode: "invalid_provenance_query",
            message,
          }),
        },
      ],
    };
  }
}

const ROUTE_METADATA_SCHEMA = z.object({
  channelId4: z.number().int(),
  slaDivide10Ms8: z.number().int(),
  provenance: z.enum(PROVENANCE_CHANNEL_ENUM_VALUES),
  sourceBridgePrefix: z.string(),
  bridgeQualifiedChannelCode: z.string(),
  originDomainId: z.string(),
  venueId: z.string(),
  originBrandColorHex: z.string(),
});

export const GET_BRIDGE_CHANNEL_CATALOG_INPUT = {
  bridgeId: z
    .enum(TRANSPORT_BRIDGE_ENUM_VALUES)
    .optional()
    .describe("Optional TransportBridgeId filter or route-pair input"),
  channelCode: z
    .enum(EXTENDED_CHANNEL_ENUM_VALUES)
    .optional()
    .describe("Optional ExtendedSignalChannelCode filter or route-pair input"),
  packedRouteWord32: z
    .number()
    .int()
    .min(0)
    .max(0xffffffff)
    .optional()
    .describe("Optional 32-bit unsigned BridgeChannelPackedWord32 to decode"),
  envelope: z
    .object({
      transportBridgeId: z.enum(TRANSPORT_BRIDGE_ENUM_VALUES),
      amountWageredCents: z.number().int(),
      ticketWriterToken: z.string().optional(),
      placedOnToken: z.string().optional(),
      wagerTypeCode: z.string().optional(),
      shortDescriptionPrefix: z.string().optional(),
      ticketLegCount: z.number().int().min(1).max(64).optional(),
      rawBoardRotationNumber: z.number().int().optional(),
      quarantineHoldDurationMs: z.number().int().min(0).optional(),
      distinctClusterWalletCount: z.number().int().min(0).optional(),
      ingestRowFlagsBitSet32: z
        .number()
        .int()
        .min(0)
        .max(0xffffffff)
        .optional(),
    })
    .optional()
    .describe(
      "Optional raw wire ingest envelope to demultiplex into (bridge, channel, packedRouteWord32)",
    ),
};

const GET_BRIDGE_CHANNEL_CATALOG_OUTPUT = {
  bridges: z.array(
    z.object({
      bridgeId: z.enum(TRANSPORT_BRIDGE_ENUM_VALUES),
      bridgeOrdinal4: z.number().int(),
      originDomain: z.string(),
      webSocketSubscriptionTopic: z.string(),
      r2LatestObjectKey: z.string(),
      upstreamWireEndpoint: z.string(),
      deduplicationWatermarkContract: z.string(),
      freshnessSlaDurationMs: z.number().int(),
      permittedChannels: z.array(z.enum(EXTENDED_CHANNEL_ENUM_VALUES)),
    }),
  ),
  channels: z.array(
    z.object({
      channelCode: z.enum(EXTENDED_CHANNEL_ENUM_VALUES),
      channelOrdinal5: z.number().int(),
      kind: z.string(),
      routingDisposition: z.string(),
      treasuryCapitalSilo: z.string(),
      vigSurchargeBasisPoints: z.number().int(),
      executionSlaDurationMs: z.number().int(),
      permittedBridgeBitMask32: z.number().int(),
      channelBehaviorFlagsBitSet32: z.number().int(),
      neuronTokenIdentifier: z.string(),
      permittedBridges: z.array(z.enum(TRANSPORT_BRIDGE_ENUM_VALUES)),
    }),
  ),
  routeCheck: z
    .object({
      bridgeId: z.enum(TRANSPORT_BRIDGE_ENUM_VALUES),
      channelCode: z.enum(EXTENDED_CHANNEL_ENUM_VALUES),
      permitted: z.boolean(),
      packedRouteWord32: z.number().int().nullable(),
      routeMetadata: ROUTE_METADATA_SCHEMA.nullable(),
    })
    .nullable(),
  decodedWord: z
    .object({
      packedRouteWord32: z.number().int(),
      bridgeOrdinal4: z.number().int(),
      channelOrdinal5: z.number().int(),
      channelBehaviorFlagsBitSet5: z.number().int(),
      routeMetadata: ROUTE_METADATA_SCHEMA,
    })
    .nullable(),
  demuxedEnvelope: z
    .object({
      bridgeId: z.enum(TRANSPORT_BRIDGE_ENUM_VALUES),
      channelCode: z.enum(EXTENDED_CHANNEL_ENUM_VALUES),
      packedRouteWord32: z.number().int(),
      canonicalVolumeCents: z.number().int(),
      effectiveWagerTypeCode: z.string(),
      routeMetadata: ROUTE_METADATA_SCHEMA,
    })
    .nullable(),
};

type GetBridgeChannelCatalogInput = z.infer<
  z.ZodObject<typeof GET_BRIDGE_CHANNEL_CATALOG_INPUT>
>;

function serializeRouteMetadata(word32: BridgeChannelPackedWord32) {
  const resolved = resolveRouteWordChannelAndSla(word32);
  return {
    channelId4: resolved.channelId4,
    slaDivide10Ms8: resolved.slaDivide10Ms8,
    provenance: resolved.provenance,
    sourceBridgePrefix: resolved.sourceBridgePrefix,
    bridgeQualifiedChannelCode: resolved.bridgeQualifiedChannelCode,
    originDomainId: resolved.originDomainId,
    venueId: resolved.venueId,
    originBrandColorHex: resolved.originBrandColorHex,
  };
}

export function runGetBridgeChannelCatalogTool(
  input: GetBridgeChannelCatalogInput,
): CallToolResult {
  try {
    const selectedBridges =
      input.bridgeId !== undefined
        ? ORDERED_BRIDGES.filter((b) => b.bridgeId === input.bridgeId)
        : ORDERED_BRIDGES;

    const selectedChannels =
      input.channelCode !== undefined
        ? ORDERED_CHANNELS.filter((c) => c.channelCode === input.channelCode)
        : ORDERED_CHANNELS;

    const bridges = selectedBridges.map((bridge) => ({
      bridgeId: bridge.bridgeId,
      bridgeOrdinal4: bridge.bridgeOrdinal4,
      originDomain: bridge.originDomain,
      webSocketSubscriptionTopic: bridge.webSocketSubscriptionTopic,
      r2LatestObjectKey: bridge.r2LatestObjectKey,
      upstreamWireEndpoint: bridge.upstreamWireEndpoint,
      deduplicationWatermarkContract: bridge.deduplicationWatermarkContract,
      freshnessSlaDurationMs: bridge.freshnessSlaDurationMs as number,
      permittedChannels: ORDERED_CHANNELS.filter((ch) =>
        isTransportBridgePermittedForChannel(bridge.bridgeId, ch.channelCode),
      ).map((ch) => ch.channelCode),
    }));

    const channels = selectedChannels.map((channel) => ({
      channelCode: channel.channelCode,
      channelOrdinal5: channel.channelOrdinal5,
      kind: channel.kind,
      routingDisposition: channel.routingDisposition,
      treasuryCapitalSilo: channel.treasuryCapitalSilo,
      vigSurchargeBasisPoints: channel.vigSurchargeBasisPoints as number,
      executionSlaDurationMs: channel.executionSlaDurationMs as number,
      permittedBridgeBitMask32: channel.permittedBridgeBitMask32 as number,
      channelBehaviorFlagsBitSet32:
        channel.channelBehaviorFlagsBitSet32 as number,
      neuronTokenIdentifier: channel.neuronTokenIdentifier,
      permittedBridges: ORDERED_BRIDGES.filter((br) =>
        isTransportBridgePermittedForChannel(br.bridgeId, channel.channelCode),
      ).map((br) => br.bridgeId),
    }));

    let routeCheck: z.infer<
      typeof GET_BRIDGE_CHANNEL_CATALOG_OUTPUT.routeCheck
    > = null;
    if (input.bridgeId !== undefined && input.channelCode !== undefined) {
      const permitted = isTransportBridgePermittedForChannel(
        input.bridgeId,
        input.channelCode,
      );
      if (permitted) {
        const word = encodeBridgeChannelPackedWord32(
          input.bridgeId,
          input.channelCode,
        );
        routeCheck = {
          bridgeId: input.bridgeId,
          channelCode: input.channelCode,
          permitted: true,
          packedRouteWord32: word as number,
          routeMetadata: serializeRouteMetadata(word),
        };
      } else {
        routeCheck = {
          bridgeId: input.bridgeId,
          channelCode: input.channelCode,
          permitted: false,
          packedRouteWord32: null,
          routeMetadata: null,
        };
      }
    }

    let decodedWord: z.infer<
      typeof GET_BRIDGE_CHANNEL_CATALOG_OUTPUT.decodedWord
    > = null;
    if (input.packedRouteWord32 !== undefined) {
      const brandedWord = (input.packedRouteWord32 >>>
        0) as BridgeChannelPackedWord32;
      if (brandedWord === NULL_BRIDGE_CHANNEL_WORD32) {
        throw new NshFrameCodecError(
          "invalid_channel_id",
          "cannot decode NULL_BRIDGE_CHANNEL_WORD32 (0xFFFFFFFF)",
        );
      }
      const unpacked = decodeBridgeChannelPackedWord32(brandedWord);
      decodedWord = {
        packedRouteWord32: brandedWord as number,
        bridgeOrdinal4: unpacked.bridgeOrdinal4,
        channelOrdinal5: unpacked.channelOrdinal5,
        channelBehaviorFlagsBitSet5: unpacked.channelBehaviorFlagsBitSet5,
        routeMetadata: serializeRouteMetadata(brandedWord),
      };
    }

    let demuxedEnvelope: z.infer<
      typeof GET_BRIDGE_CHANNEL_CATALOG_OUTPUT.demuxedEnvelope
    > = null;
    if (input.envelope !== undefined) {
      const wireEnvelope: RawWireIngestEnvelope = {
        transportBridgeId: input.envelope.transportBridgeId,
        amountWageredCents: asCents(input.envelope.amountWageredCents),
        ...(input.envelope.ticketWriterToken !== undefined
          ? { ticketWriterToken: input.envelope.ticketWriterToken }
          : {}),
        ...(input.envelope.placedOnToken !== undefined
          ? { placedOnToken: input.envelope.placedOnToken }
          : {}),
        ...(input.envelope.wagerTypeCode !== undefined
          ? { wagerTypeCode: input.envelope.wagerTypeCode }
          : {}),
        ...(input.envelope.shortDescriptionPrefix !== undefined
          ? { shortDescriptionPrefix: input.envelope.shortDescriptionPrefix }
          : {}),
        ...(input.envelope.ticketLegCount !== undefined
          ? { ticketLegCount: input.envelope.ticketLegCount }
          : {}),
        ...(input.envelope.rawBoardRotationNumber !== undefined
          ? { rawBoardRotationNumber: input.envelope.rawBoardRotationNumber }
          : {}),
        ...(input.envelope.quarantineHoldDurationMs !== undefined
          ? {
              quarantineHoldDurationMs: asDurationMilliseconds(
                input.envelope.quarantineHoldDurationMs,
              ),
            }
          : {}),
        ...(input.envelope.distinctClusterWalletCount !== undefined
          ? {
              distinctClusterWalletCount:
                input.envelope.distinctClusterWalletCount,
            }
          : {}),
        ...(input.envelope.ingestRowFlagsBitSet32 !== undefined
          ? {
              ingestRowFlagsBitSet32: asBitSet32(
                input.envelope.ingestRowFlagsBitSet32,
              ),
            }
          : {}),
      };
      const resolved = resolveSeparatedBridgeAndChannelEnvelope(wireEnvelope);
      demuxedEnvelope = {
        bridgeId: resolved.bridgeSpecification.bridgeId,
        channelCode: resolved.channelSpecification.channelCode,
        packedRouteWord32: resolved.packedRouteWord32 as number,
        canonicalVolumeCents: resolved.canonicalVolumeCents as number,
        effectiveWagerTypeCode: resolved.effectiveWagerTypeCode,
        routeMetadata: serializeRouteMetadata(resolved.packedRouteWord32),
      };
    }

    const payload = {
      bridges,
      channels,
      routeCheck,
      decodedWord,
      demuxedEnvelope,
    };

    return {
      structuredContent: payload,
      content: [{ type: "text", text: JSON.stringify(payload) }],
    };
  } catch (error) {
    if (error instanceof DodGateFailureError) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              errorCode: `GATE_0${error.gate}_${error.section}`,
              gate: error.gate,
              section: error.section,
              message: error.message,
            }),
          },
        ],
      };
    }
    if (error instanceof NshFrameCodecError) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              errorCode: error.code,
              message: error.message,
            }),
          },
        ],
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: false,
            errorCode: "bridge_catalog_error",
            message,
          }),
        },
      ],
    };
  }
}

export const CHECK_SOR_SLIPPAGE_INPUT = {
  league: z
    .string()
    .min(1)
    .max(32)
    .optional()
    .describe(
      "Sport league key (for example NBA, NFL, CFB, EPL, NHL; defaults to DEFAULT)",
    ),
  slippageBps: z
    .number()
    .finite()
    .optional()
    .describe(
      "Observed or proposed execution slippage in basis points (100 bps = 1%). Optional when asks + budgetUsd are provided.",
    ),
  maxSlippageBpsOverride: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .optional()
    .describe("Optional explicit policy ceiling in basis points"),
  enforceSor1Ceiling: z
    .boolean()
    .optional()
    .describe(
      "Enforce the 200 bps SOR-1 ceiling alongside the sport-tier cap (default: true)",
    ),
  budgetUsd: z
    .number()
    .min(0)
    .max(1_000_000)
    .optional()
    .describe(
      "Order notional in USD used to walk the ask ladder when asks are supplied",
    ),
  midPrice: z
    .number()
    .gt(0)
    .lt(1)
    .optional()
    .describe(
      "Optional mid probability in (0, 1) for relative slippage; defaults to best ask when walking asks",
    ),
  asks: z
    .array(
      z.object({
        price: z.number().gt(0).lt(1),
        size: z.number().positive(),
      }),
    )
    .max(512)
    .optional()
    .describe(
      "Optional venue ask levels (probability price in (0,1), contract size > 0)",
    ),
};

const CHECK_SOR_SLIPPAGE_OUTPUT = {
  allowed: z.boolean(),
  blockReason: z.string().nullable(),
  league: z.string(),
  observedSlippageBps: z.number().int().nullable(),
  rawPriceImpactBps: z.number().int().nullable(),
  tierMaxSlippageBps: z.number().int(),
  effectiveMaxSlippageBps: z.number().int(),
  sor1CeilingBps: z.number().int(),
  nshFrameU8MaxBps: z.number().int(),
  sor1Compliant: z.boolean(),
  fitsNshFrameU8: z.boolean(),
  tier: z.object({
    minEdgeBps: z.number().int(),
    maxSlippageBps: z.number().int(),
    maxOrderUsd: z.number(),
  }),
  availableSportTiers: z.record(
    z.string(),
    z.object({
      minEdgeBps: z.number().int(),
      maxSlippageBps: z.number().int(),
      maxOrderUsd: z.number(),
    }),
  ),
  bookWalk: z
    .object({
      budgetUsd: z.number(),
      contracts: z.number(),
      costUsd: z.number(),
      avgPrice: z.number().nullable(),
      bestPrice: z.number().nullable(),
      lastPrice: z.number().nullable(),
      depthContracts: z.number(),
      referencePrice: z.number().nullable(),
      fullyCovered: z.boolean(),
    })
    .nullable(),
};

type CheckSorSlippageInput = z.infer<
  z.ZodObject<typeof CHECK_SOR_SLIPPAGE_INPUT>
>;

export function runCheckSorSlippageTool(
  input: CheckSorSlippageInput,
  policyEnv: Readonly<Record<string, string | undefined>> = Bun.env,
): CallToolResult {
  const league = (input.league ?? "DEFAULT").trim().toUpperCase() || "DEFAULT";
  const policy = policyFromEnv(policyEnv);
  const tier = tierForPolicy(policy, league);
  const enforceSor1 = input.enforceSor1Ceiling ?? true;
  const tierMaxSlippageBps =
    input.maxSlippageBpsOverride ?? tier.maxSlippageBps;
  const effectiveMaxSlippageBps = enforceSor1
    ? Math.min(tierMaxSlippageBps, SOR1_MAX_SLIPPAGE_BPS)
    : tierMaxSlippageBps;

  let observedSlippageBps: number | null =
    input.slippageBps !== undefined ? Math.round(input.slippageBps) : null;
  let rawPriceImpactBps: number | null = null;
  let bookWalkSummary: z.infer<typeof CHECK_SOR_SLIPPAGE_OUTPUT.bookWalk> =
    null;
  let walkBlockReason: string | null = null;

  if (input.asks !== undefined) {
    const budgetUsd = input.budgetUsd ?? tier.maxOrderUsd;
    const sortedAsks = [...input.asks].sort((a, b) => a.price - b.price);
    if (budgetUsd <= 0) {
      walkBlockReason = "zero_budget";
      const emptyWalk = walkBook(sortedAsks, 0);
      bookWalkSummary = {
        budgetUsd,
        contracts: emptyWalk.contracts,
        costUsd: emptyWalk.costUsd,
        avgPrice: emptyWalk.avgPrice,
        bestPrice: emptyWalk.bestPrice,
        lastPrice: emptyWalk.lastPrice,
        depthContracts: emptyWalk.depthContracts,
        referencePrice: input.midPrice ?? emptyWalk.bestPrice,
        fullyCovered: false,
      };
    } else if (sortedAsks.length === 0) {
      walkBlockReason = "no_book";
      bookWalkSummary = {
        budgetUsd,
        contracts: 0,
        costUsd: 0,
        avgPrice: null,
        bestPrice: null,
        lastPrice: null,
        depthContracts: 0,
        referencePrice: input.midPrice ?? null,
        fullyCovered: false,
      };
    } else {
      const walk = walkBook(sortedAsks, budgetUsd);
      const referencePrice = input.midPrice ?? walk.bestPrice;
      const fullyCovered = walk.costUsd + 1e-6 >= budgetUsd;
      if (!fullyCovered) {
        walkBlockReason = "insufficient_depth";
      }
      if (
        walk.avgPrice !== null &&
        referencePrice !== null &&
        referencePrice > 0
      ) {
        observedSlippageBps = Math.round(
          (Math.abs(walk.avgPrice - referencePrice) / referencePrice) * 10_000,
        );
        rawPriceImpactBps = Math.round(
          Math.max(0, walk.avgPrice - referencePrice) * 10_000,
        );
      }
      bookWalkSummary = {
        budgetUsd,
        contracts: walk.contracts,
        costUsd: walk.costUsd,
        avgPrice: walk.avgPrice,
        bestPrice: walk.bestPrice,
        lastPrice: walk.lastPrice,
        depthContracts: walk.depthContracts,
        referencePrice,
        fullyCovered,
      };
    }
  } else if (observedSlippageBps === null) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: false,
            errorCode: "missing_slippage_input",
            message:
              "Provide either slippageBps or asks (with optional budgetUsd) to evaluate SOR-1 slippage.",
          }),
        },
      ],
    };
  }

  let blockReason: string | null = walkBlockReason;
  if (blockReason === null && observedSlippageBps !== null) {
    if (observedSlippageBps < 0) {
      blockReason = "negative_slippage_invalid";
    } else if (observedSlippageBps > NSH_FRAME_SLIPPAGE_U8_MAX) {
      blockReason = "exceeds_nsh_frame_u8";
    } else if (
      enforceSor1 &&
      observedSlippageBps > SOR1_MAX_SLIPPAGE_BPS &&
      tierMaxSlippageBps > SOR1_MAX_SLIPPAGE_BPS
    ) {
      blockReason = "exceeds_sor1_ceiling";
    } else if (observedSlippageBps > effectiveMaxSlippageBps) {
      blockReason = "slippage_exceeds_policy";
    }
  }

  const fitsNshFrameU8 =
    observedSlippageBps !== null &&
    Number.isInteger(observedSlippageBps) &&
    observedSlippageBps >= 0 &&
    observedSlippageBps <= NSH_FRAME_SLIPPAGE_U8_MAX;
  const sor1Compliant =
    observedSlippageBps !== null &&
    observedSlippageBps >= 0 &&
    observedSlippageBps <= SOR1_MAX_SLIPPAGE_BPS;

  const payload = {
    allowed: blockReason === null && observedSlippageBps !== null,
    blockReason,
    league,
    observedSlippageBps,
    rawPriceImpactBps,
    tierMaxSlippageBps,
    effectiveMaxSlippageBps,
    sor1CeilingBps: SOR1_MAX_SLIPPAGE_BPS,
    nshFrameU8MaxBps: NSH_FRAME_SLIPPAGE_U8_MAX,
    sor1Compliant,
    fitsNshFrameU8,
    tier: {
      minEdgeBps: tier.minEdgeBps,
      maxSlippageBps: tier.maxSlippageBps,
      maxOrderUsd: tier.maxOrderUsd,
    },
    availableSportTiers: Object.fromEntries(
      Object.entries(DEFAULT_SPORT_TIERS).map(([key, value]) => [
        key,
        {
          minEdgeBps: value.minEdgeBps,
          maxSlippageBps: value.maxSlippageBps,
          maxOrderUsd: value.maxOrderUsd,
        },
      ]),
    ),
    bookWalk: bookWalkSummary,
  };

  return {
    structuredContent: payload,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

export const DECODE_NSH_FRAME_INPUT = {
  payload: z
    .string()
    .min(1)
    .max(1024)
    .describe(
      "64-byte NSH binary frame encoded as hex (optional 0x prefix) or base64",
    ),
  encoding: z
    .enum(["hex", "base64"])
    .optional()
    .describe("Wire encoding of payload (auto-detected when omitted)"),
};

const DECODE_NSH_FRAME_OUTPUT = {
  byteLength: z.number().int(),
  magicByte8: z.number().int(),
  versionByte8: z.number().int(),
  messageType: z.number().int(),
  messageTypeName: z.string(),
  packedHandle32: z.number().int(),
  handle: z.object({
    channelId4: z.number().int(),
    slaDivide10Ms8: z.number().int(),
    slaMs: z.number().int(),
    rowIndex20: z.number().int(),
  }),
  betGroupId: z.string(),
  betGroupTag: z.string(),
  stakeUsdc: z.number(),
  bookOdds: z.number(),
  polyAvgPrice: z.number(),
  liabilityDelta: z.number(),
  timestampMs: z.number().int(),
  timestampIso: z.string(),
  originDomainWireId: z.number().int(),
  originDomainId: z.string(),
  writerLaneWireId: z.number().int(),
  writerLaneId: z.string(),
  flagsBitSet16: z.number().int(),
  slippageBps: z.number().int(),
  sor1Compliant: z.boolean(),
  layoutOffsets: z.record(
    z.string(),
    z.object({ offset: z.number().int(), size: z.number().int() }),
  ),
};

type DecodeNshFrameInput = z.infer<z.ZodObject<typeof DECODE_NSH_FRAME_INPUT>>;

function decodeWirePayloadToBytes(
  rawPayload: string,
  encoding: "hex" | "base64" | undefined,
): Uint8Array {
  const trimmed = rawPayload.trim();
  if (trimmed === "") {
    throw new NshFrameCodecError("short_frame", "empty frame payload");
  }

  const resolvedEncoding: "hex" | "base64" =
    encoding ??
    (/^0x/i.test(trimmed) ||
    (/^[0-9a-fA-F\s]+$/.test(trimmed) &&
      trimmed.replace(/\s+/g, "").length !== 88)
      ? "hex"
      : "base64");

  if (resolvedEncoding === "hex") {
    const compact = trimmed.replace(/^0x/i, "").replace(/\s+/g, "");
    if (compact.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(compact)) {
      throw new RangeError(
        "Invalid hex frame payload: expected an even number of hexadecimal digits",
      );
    }
    const bytes = new Uint8Array(compact.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Number.parseInt(compact.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  const normalizedB64 = trimmed
    .replace(/\s+/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  if (
    normalizedB64.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(normalizedB64)
  ) {
    throw new RangeError(
      "Invalid base64 frame payload: malformed base64 character sequence",
    );
  }
  return new Uint8Array(Buffer.from(normalizedB64, "base64"));
}

export function runDecodeNshFrameTool(
  input: DecodeNshFrameInput,
): CallToolResult {
  try {
    const bytes = decodeWirePayloadToBytes(input.payload, input.encoding);
    if (bytes.byteLength > NSH_FRAME_BYTE_LENGTH) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              errorCode: "oversized_frame",
              message: `NSH frame must be exactly ${NSH_FRAME_BYTE_LENGTH} bytes (got ${bytes.byteLength})`,
            }),
          },
        ],
      };
    }

    const frame = readNshBinaryFrame(bytes);
    const packedHandle32 = packChannelHandle32(
      frame.channelId,
      frame.slaDivide10Ms,
      frame.rowIndex,
    );
    const unpackedHandle = unpackChannelHandle32(packedHandle32);
    const betGroupDecimal = frame.betGroupId.toString(10);

    const payload = {
      byteLength: bytes.byteLength,
      magicByte8: NSH_FRAME_MAGIC,
      versionByte8: NSH_FRAME_VERSION,
      messageType: frame.messageType,
      messageTypeName:
        MESSAGE_TYPE_NAMES[frame.messageType] ?? `UNKNOWN_${frame.messageType}`,
      packedHandle32: packedHandle32 as number,
      handle: {
        channelId4: unpackedHandle.channelId4,
        slaDivide10Ms8: unpackedHandle.slaDivide10Ms8,
        slaMs: unpackedHandle.slaDivide10Ms8 * 10,
        rowIndex20: unpackedHandle.rowIndex20,
      },
      betGroupId: betGroupDecimal,
      betGroupTag: `M.G${betGroupDecimal}`,
      stakeUsdc: frame.stakeUsdc,
      bookOdds: frame.bookOdds,
      polyAvgPrice: frame.polyAvgPrice,
      liabilityDelta: frame.liabilityDelta,
      timestampMs: frame.timestampMs,
      timestampIso: new Date(frame.timestampMs).toISOString(),
      originDomainWireId: frame.originDomainWireId,
      originDomainId: frame.originDomainId,
      writerLaneWireId: frame.writerLaneWireId,
      writerLaneId: frame.writerLaneId,
      flagsBitSet16: frame.flags,
      slippageBps: frame.slippageBps,
      sor1Compliant: frame.slippageBps <= SOR1_MAX_SLIPPAGE_BPS,
      layoutOffsets: Object.fromEntries(
        Object.entries(NSH_FRAME_LAYOUT).map(([key, spec]) => [
          key,
          { offset: spec.offset, size: spec.size },
        ]),
      ),
    };

    return {
      structuredContent: payload,
      content: [{ type: "text", text: JSON.stringify(payload) }],
    };
  } catch (error) {
    if (error instanceof NshFrameCodecError) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              errorCode: error.code,
              message: error.message,
            }),
          },
        ],
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: false,
            errorCode: "invalid_encoding",
            message,
          }),
        },
      ],
    };
  }
}

// ============================================================================
// 2. MCP SERVER FACTORY
// ============================================================================

export interface SportsdeskMcpServerOptions {
  readonly policyEnv?: Readonly<Record<string, string | undefined>>;
}

export function createSportsdeskMcpServer(
  options: SportsdeskMcpServerOptions = {},
): McpServer {
  const server = new McpServer({
    name: SPORTSDESK_MCP_SERVER_NAME,
    version: SPORTSDESK_MCP_SERVER_VERSION,
    title: "SportsDesk Operations Spine",
  });

  const readOnlyAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  } as const;

  server.registerTool(
    "get_channel_provenance",
    {
      title: "Get Ingestion Channel Provenance",
      description:
        "Query the precomputed 24-bit RGB provenance palette, neuron token SLAs, writer-lane aliases, and upstream origin domains directly from the generated design/tokens.toml TypeScript SSOT.",
      inputSchema: GET_CHANNEL_PROVENANCE_INPUT,
      outputSchema: GET_CHANNEL_PROVENANCE_OUTPUT,
      annotations: {
        title: "Get Channel Provenance",
        ...readOnlyAnnotations,
      },
    },
    (input) => runGetChannelProvenanceTool(input),
  );

  server.registerTool(
    "get_bridge_channel_catalog",
    {
      title: "Get Bridge & Channel Routing Catalog",
      description:
        "Inspect the 10 transport ingestion bridges and 16 signal channels, verify bridge-to-channel bitmask permissions, decode 32-bit BridgeChannelPackedWord32 route handles, or demultiplex a raw wire ingest envelope.",
      inputSchema: GET_BRIDGE_CHANNEL_CATALOG_INPUT,
      outputSchema: GET_BRIDGE_CHANNEL_CATALOG_OUTPUT,
      annotations: {
        title: "Get Bridge & Channel Catalog",
        ...readOnlyAnnotations,
      },
    },
    (input) => runGetBridgeChannelCatalogTool(input),
  );

  server.registerTool(
    "check_sor_slippage",
    {
      title: "Check SOR-1 Slippage Policy",
      description:
        "Evaluate proposed execution slippage or walk an ask ladder against per-sport execution tiers (NBA/NFL/CFB/EPL/NHL), the 200 bps SOR-1 ceiling, and the 64-byte NSH frame u8 slippage slot.",
      inputSchema: CHECK_SOR_SLIPPAGE_INPUT,
      outputSchema: CHECK_SOR_SLIPPAGE_OUTPUT,
      annotations: {
        title: "Check SOR-1 Slippage",
        ...readOnlyAnnotations,
      },
    },
    (input) => runCheckSorSlippageTool(input, options.policyEnv ?? Bun.env),
  );

  server.registerTool(
    "decode_nsh_frame",
    {
      title: "Decode 64-Byte NSH Binary Frame",
      description:
        "Decode and validate a 64-byte little-endian NSH binary frame (hex or base64) into unpacked channel/SLA/row handles, 64-bit betGroupId, financial floats, origin-domain and writer-lane wire ids, flags, and SOR-1 slippage.",
      inputSchema: DECODE_NSH_FRAME_INPUT,
      outputSchema: DECODE_NSH_FRAME_OUTPUT,
      annotations: {
        title: "Decode 64B NSH Frame",
        ...readOnlyAnnotations,
      },
    },
    (input) => runDecodeNshFrameTool(input),
  );

  return server;
}

// ============================================================================
// 3. CONSTANT-TIME BEARER AUTHENTICATION & STREAMABLE HTTP TRANSPORT
// ============================================================================

export type McpAuthVerificationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly status: 401 | 503;
      readonly code: number;
      readonly message: string;
    };

function sha256Bytes(input: string): Buffer {
  return createHash("sha256").update(input, "utf8").digest();
}

export function verifyMcpBearerAuth(
  req: Request,
  expectedToken: string | undefined,
): McpAuthVerificationResult {
  const normalizedExpected = expectedToken?.trim() ?? "";
  if (normalizedExpected === "") {
    return {
      ok: false,
      status: 503,
      code: -32000,
      message: "SPORTSDESK_ADMIN_TOKEN is not set on the server",
    };
  }

  const rawHeader = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(rawHeader.trim());
  if (!match?.[1]) {
    return {
      ok: false,
      status: 401,
      code: -32000,
      message: "Missing or malformed Authorization: Bearer <token> header",
    };
  }

  const actualDigest = sha256Bytes(match[1]);
  const expectedDigest = sha256Bytes(normalizedExpected);
  if (!timingSafeEqual(actualDigest, expectedDigest)) {
    return {
      ok: false,
      status: 401,
      code: -32000,
      message: "Invalid bearer token",
    };
  }

  return { ok: true };
}

export interface SportsdeskMcpHttpHandlerOptions {
  /** Run without `Mcp-Session-Id` state; each request uses an isolated server/transport pair. */
  readonly stateless?: boolean;
  /** Return `application/json` bodies instead of `text/event-stream` on `POST /mcp`. */
  readonly enableJsonResponse?: boolean;
  /** Maximum concurrent stateful sessions retained before oldest-session eviction (default: 256). */
  readonly maxSessions?: number;
  /** Require `Authorization: Bearer <token>` (default: true). */
  readonly requireAuth?: boolean;
  /** Resolve expected Bearer token per request (defaults to `Bun.env.SPORTSDESK_ADMIN_TOKEN`). */
  readonly resolveAuthToken?: () => string | undefined;
  /** Allowed cross-origin callers echoed into `Access-Control-Allow-Origin`. */
  readonly allowedOrigins?: readonly string[];
  /** Optional policy environment passed to `check_sor_slippage`. */
  readonly policyEnv?: Readonly<Record<string, string | undefined>>;
}

interface StatefulMcpSessionEntry {
  readonly sessionId: string;
  readonly server: McpServer;
  readonly transport: WebStandardStreamableHTTPServerTransport;
  lastSeenAtMs: number;
}

export interface SportsdeskMcpHttpHandler {
  readonly stateless: boolean;
  readonly requireAuth: boolean;
  readonly handleRequest: (req: Request) => Promise<Response>;
  readonly getActiveSessionCount: () => number;
  readonly hasSession: (sessionId: string) => boolean;
  readonly closeAll: () => Promise<void>;
}

function buildMcpSecurityHeaders(
  req: Request,
  allowedOrigins: readonly string[],
): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": MCP_ALLOW_METHODS,
    "Access-Control-Allow-Headers": MCP_ALLOW_HEADERS,
    "Access-Control-Expose-Headers": MCP_EXPOSE_HEADERS,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    Vary: "Origin, Authorization",
  };
  const origin = req.headers.get("origin");
  if (origin !== null && allowedOrigins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function withMergedHeaders(
  response: Response,
  extraHeaders: Record<string, string>,
): Response {
  const merged = new Headers(response.headers);
  for (const [key, value] of Object.entries(extraHeaders)) {
    if (key.toLowerCase() === "cache-control" && merged.has("cache-control")) {
      continue;
    }
    merged.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}

function jsonRpcErrorResponse(
  status: number,
  code: number,
  message: string,
  extraHeaders: Record<string, string>,
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        ...extraHeaders,
      },
    },
  );
}

function attachStreamFinalizer(
  response: Response,
  onFinalize: () => Promise<void>,
): Response {
  const body = response.body;
  const contentType = response.headers.get("content-type") ?? "";
  if (body === null || !contentType.includes("text/event-stream")) {
    return response;
  }

  const reader = body.getReader();
  let finalized = false;
  const runFinalize = async (): Promise<void> => {
    if (finalized) return;
    finalized = true;
    await onFinalize();
  };

  const wrapped = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          await runFinalize();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (err) {
        await runFinalize();
        throw err;
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await runFinalize();
      }
    },
  });

  return new Response(wrapped, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function createSportsdeskMcpHttpHandler(
  options: SportsdeskMcpHttpHandlerOptions = {},
): SportsdeskMcpHttpHandler {
  const stateless = options.stateless === true;
  const enableJsonResponse = options.enableJsonResponse === true;
  const maxSessions = Math.max(
    1,
    Math.trunc(options.maxSessions ?? DEFAULT_MAX_MCP_SESSIONS),
  );
  const requireAuth = options.requireAuth ?? true;
  const resolveAuthToken =
    options.resolveAuthToken ?? (() => Bun.env.SPORTSDESK_ADMIN_TOKEN);
  const allowedOrigins = options.allowedOrigins ?? [];

  const sessions: StatefulMcpSessionEntry[] = [];
  const activeStatelessServers: McpServer[] = [];

  function findSessionIndex(sessionId: string): number {
    for (let i = 0; i < sessions.length; i++) {
      if (sessions[i]?.sessionId === sessionId) return i;
    }
    return -1;
  }

  function removeSessionEntry(
    sessionId: string,
  ): StatefulMcpSessionEntry | null {
    const idx = findSessionIndex(sessionId);
    if (idx < 0) return null;
    const [removed] = sessions.splice(idx, 1);
    return removed ?? null;
  }

  function removeStatelessServer(server: McpServer): void {
    const idx = activeStatelessServers.indexOf(server);
    if (idx >= 0) {
      activeStatelessServers.splice(idx, 1);
    }
  }

  async function evictOldestSessionsIfNeeded(): Promise<void> {
    while (sessions.length >= maxSessions) {
      let oldestIndex = 0;
      let oldestTime = sessions[0]?.lastSeenAtMs ?? Infinity;
      for (let i = 1; i < sessions.length; i++) {
        const ts = sessions[i]?.lastSeenAtMs ?? Infinity;
        if (ts < oldestTime) {
          oldestTime = ts;
          oldestIndex = i;
        }
      }
      const [evicted] = sessions.splice(oldestIndex, 1);
      if (evicted) {
        await evicted.server.close();
      }
    }
  }

  async function handleStatelessRequest(
    req: Request,
    secHeaders: Record<string, string>,
  ): Promise<Response> {
    const mcpServer = createSportsdeskMcpServer(
      options.policyEnv ? { policyEnv: options.policyEnv } : {},
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse,
      keepAliveMs: DEFAULT_SSE_KEEPALIVE_MS,
    });
    await mcpServer.connect(transport);
    activeStatelessServers.push(mcpServer);

    let closed = false;
    const closePair = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      removeStatelessServer(mcpServer);
      await mcpServer.close();
    };

    try {
      const rawResponse = await transport.handleRequest(req);
      const merged = withMergedHeaders(rawResponse, secHeaders);
      const contentType = merged.headers.get("content-type") ?? "";
      if (merged.body !== null && contentType.includes("text/event-stream")) {
        return attachStreamFinalizer(merged, closePair);
      }
      await closePair();
      return merged;
    } catch (error) {
      await closePair();
      throw error;
    }
  }

  async function handleStatefulRequest(
    req: Request,
    secHeaders: Record<string, string>,
  ): Promise<Response> {
    const sessionIdHeader = req.headers.get("mcp-session-id")?.trim() ?? "";

    if (sessionIdHeader !== "") {
      const idx = findSessionIndex(sessionIdHeader);
      const existing = idx >= 0 ? sessions[idx] : undefined;
      if (!existing) {
        return jsonRpcErrorResponse(
          404,
          -32001,
          "Session not found",
          secHeaders,
        );
      }
      existing.lastSeenAtMs = Date.now();
      const rawResponse = await existing.transport.handleRequest(req);
      return withMergedHeaders(rawResponse, secHeaders);
    }

    if (req.method === "GET") {
      const accept = req.headers.get("accept") ?? "";
      if (!accept.includes("text/event-stream")) {
        return jsonRpcErrorResponse(
          406,
          -32000,
          "Not Acceptable: Client must accept text/event-stream",
          secHeaders,
        );
      }
      return jsonRpcErrorResponse(
        400,
        -32000,
        "Bad Request: Mcp-Session-Id header is required",
        secHeaders,
      );
    }

    if (req.method === "DELETE") {
      return jsonRpcErrorResponse(
        400,
        -32000,
        "Bad Request: Mcp-Session-Id header is required",
        secHeaders,
      );
    }

    const mcpServer = createSportsdeskMcpServer(
      options.policyEnv ? { policyEnv: options.policyEnv } : {},
    );
    let registeredSessionId: string | null = null;

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse,
      keepAliveMs: DEFAULT_SSE_KEEPALIVE_MS,
      onsessioninitialized: async (newSessionId: string) => {
        await evictOldestSessionsIfNeeded();
        registeredSessionId = newSessionId;
        sessions.push({
          sessionId: newSessionId,
          server: mcpServer,
          transport,
          lastSeenAtMs: Date.now(),
        });
      },
      onsessionclosed: async (closedSessionId: string) => {
        const removed = removeSessionEntry(closedSessionId);
        if (removed) {
          await removed.server.close();
        }
      },
    });

    await mcpServer.connect(transport);
    try {
      const rawResponse = await transport.handleRequest(req);
      if (registeredSessionId === null) {
        await mcpServer.close();
      }
      return withMergedHeaders(rawResponse, secHeaders);
    } catch (error) {
      if (registeredSessionId !== null) {
        removeSessionEntry(registeredSessionId);
      }
      await mcpServer.close();
      throw error;
    }
  }

  async function handleRequest(req: Request): Promise<Response> {
    const secHeaders = buildMcpSecurityHeaders(req, allowedOrigins);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: secHeaders });
    }

    if (requireAuth) {
      const auth = verifyMcpBearerAuth(req, resolveAuthToken());
      if (!auth.ok) {
        const authHeaders: Record<string, string> = {
          ...secHeaders,
          ...(auth.status === 401
            ? { "WWW-Authenticate": 'Bearer realm="sportsdesk-mcp"' }
            : {}),
        };
        return jsonRpcErrorResponse(
          auth.status,
          auth.code,
          auth.message,
          authHeaders,
        );
      }
    }

    if (
      req.method !== "GET" &&
      req.method !== "POST" &&
      req.method !== "DELETE"
    ) {
      return jsonRpcErrorResponse(405, -32000, "Method not allowed.", {
        ...secHeaders,
        Allow: "GET, POST, DELETE",
      });
    }

    if (stateless) {
      return handleStatelessRequest(req, secHeaders);
    }
    return handleStatefulRequest(req, secHeaders);
  }

  async function closeAll(): Promise<void> {
    const activeSessions = sessions.splice(0, sessions.length);
    const statelessList = activeStatelessServers.splice(
      0,
      activeStatelessServers.length,
    );
    await Promise.all([
      ...activeSessions.map((entry) => entry.server.close()),
      ...statelessList.map((srv) => srv.close()),
    ]);
  }

  return {
    stateless,
    requireAuth,
    handleRequest,
    getActiveSessionCount: () => sessions.length,
    hasSession: (sessionId: string) => findSessionIndex(sessionId) >= 0,
    closeAll,
  };
}
