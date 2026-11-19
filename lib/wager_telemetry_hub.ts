/**
 * @file lib/wager_telemetry_hub.ts
 * @description 32-byte wager-tick wire frame and a bridge-authorized WebSocket
 * fan-out for live desk telemetry.
 *
 * Layout (little-endian, every byte initialized):
 *
 *   0   u8   magic 0x57 ("W")
 *   1   u8   frame version (1)
 *   2   u8   message type (1 = WAGER_TICK)
 *   3   u8   reserved, always 0
 *   4   u32  `BridgeChannelPackedWord32`: bridge [0..3] | channel [4..8] | flags [9..13]
 *   8   i32  line in hundredths (spreads and totals can be negative)
 *   12  i32  stake in cents
 *   16  u64  wager id
 *   24  u64  wall-clock epoch milliseconds
 *
 * The route word is the repo's existing `BridgeChannelPackedWord32`, not a second
 * bridge/channel taxonomy: a socket is authorized by decoding the frame's bridge
 * ordinal and testing it against the socket's `TransportBridgeBitMask32`. The
 * FANTASY_402 vs PARTNER_118 split falls out of `TRANSPORT_BRIDGE_SPECIFICATION_TABLE`
 * (`ORIGIN_SPORTSBOOK_FANTASY402` vs `ORIGIN_SPORTSBOOK_GSLIVE_PARTNER118`).
 *
 * `WagerTickFrameWriter` reuses one buffer and one `DataView` for its lifetime, like
 * `NshFrameWriter`. The returned view is only valid until the next `write()`. The hub
 * therefore copies the packed frame once per tick before fanning it out: Bun may retain
 * the view in a socket's send queue, and mutating it under a pending send would deliver
 * the next tick's bytes to this tick's clients. One 32-byte copy per tick is the price
 * of that correctness; the per-socket path stays allocation-free.
 */

import type {
  BridgeChannelPackedWord32,
  Cents,
  EpochMs,
  LineHundredths,
  TransportBridgeBitMask32,
} from "../design/domain-branded-types.ts";
import { asBridgeChannelPackedWord32 } from "../design/domain-branded-types.ts";
import {
  asCents,
  asLineHundredths,
  TRANSPORT_BRIDGE_SPECIFICATION_TABLE,
} from "./bridge_and_channel_router.ts";
import {
  sendNshFrameToSubscriber,
  type NshSubscriberSocket,
} from "./nsh_frame_codec.ts";
import { decodeBridgeChannelPackedWord32 } from "./nsh_frame_schema.ts";

export const WAGER_TICK_FRAME_BYTES = 32 as const;
export const WAGER_TICK_MAGIC = 0x57; // "W"
export const WAGER_TICK_VERSION = 1;
export const WAGER_TICK_MESSAGE_TYPE = 1;

const UINT32_BASE = 0x1_0000_0000;
const UINT64_MAX = 0xffffffffffffffffn;
const INT32_MIN = -0x8000_0000;
const INT32_MAX = 0x7fff_ffff;
/** Wall-clock epoch ms stay below 2^53 so the two-u32 write is exact. */
const MAX_WALL_EPOCH_MS_EXCLUSIVE = 2 ** 53;

const MAX_BRIDGE_ORDINAL4 = Math.max(
  ...Object.values(TRANSPORT_BRIDGE_SPECIFICATION_TABLE).map(
    (specification) => specification.bridgeOrdinal4,
  ),
);

export type WagerTickFrameErrorCode =
  | "wrong_length"
  | "invalid_magic"
  | "unsupported_version"
  | "unknown_message_type"
  | "non_zero_reserved"
  | "invalid_route_word"
  | "unknown_bridge_ordinal"
  | "line_out_of_range"
  | "stake_out_of_range"
  | "wager_id_out_of_range"
  | "epoch_ms_out_of_range";

export class WagerTickFrameError extends Error {
  readonly code: WagerTickFrameErrorCode;

  constructor(code: WagerTickFrameErrorCode, detail: string) {
    super(`ERR_WAGER_TICK_FRAME: ${code}: ${detail}`);
    this.name = "WagerTickFrameError";
    this.code = code;
  }
}

export interface WagerTickInput {
  readonly routeWord32: BridgeChannelPackedWord32;
  readonly lineHundredths: LineHundredths;
  readonly stakeCents: Cents;
  readonly wagerId: bigint;
  readonly wallEpochMs: EpochMs;
}

export interface WagerTickFrame {
  readonly routeWord32: BridgeChannelPackedWord32;
  readonly lineHundredths: LineHundredths;
  readonly stakeCents: Cents;
  readonly wagerId: bigint;
  readonly wallEpochMs: EpochMs;
}

/**
 * Validating constructor for the wall-clock field. `EpochMs` has no generated
 * constructor, and every value written here must survive the two-u32 split.
 */
export function asWallEpochMs(value: number): EpochMs {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >= MAX_WALL_EPOCH_MS_EXCLUSIVE
  ) {
    throw new WagerTickFrameError(
      "epoch_ms_out_of_range",
      `expected an integer in [0, 2^53), got ${String(value)}`,
    );
  }
  return value as EpochMs;
}

type DecodedRouteWord = ReturnType<typeof decodeBridgeChannelPackedWord32>;

function decodeRouteWord(
  routeWord32: BridgeChannelPackedWord32,
): DecodedRouteWord {
  let decoded: DecodedRouteWord;
  try {
    decoded = decodeBridgeChannelPackedWord32(routeWord32);
  } catch (error) {
    throw new WagerTickFrameError(
      "invalid_route_word",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (decoded.bridgeOrdinal4 > MAX_BRIDGE_ORDINAL4) {
    throw new WagerTickFrameError(
      "unknown_bridge_ordinal",
      `bridge ordinal ${decoded.bridgeOrdinal4} exceeds the ${MAX_BRIDGE_ORDINAL4} registered transport bridges`,
    );
  }
  return decoded;
}

function assertLineHundredths(value: number): void {
  if (!Number.isInteger(value) || value < INT32_MIN || value > INT32_MAX) {
    throw new WagerTickFrameError(
      "line_out_of_range",
      `expected an int32, got ${String(value)}`,
    );
  }
}

function assertStakeCents(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > INT32_MAX) {
    throw new WagerTickFrameError(
      "stake_out_of_range",
      `expected an int32 >= 0, got ${String(value)}`,
    );
  }
}

function assertWagerId(value: bigint): void {
  if (typeof value !== "bigint" || value < 0n || value > UINT64_MAX) {
    throw new WagerTickFrameError(
      "wager_id_out_of_range",
      `expected a u64 bigint, got ${String(value)}`,
    );
  }
}

/**
 * Packs [u32 high | u32 low] with the same bytes `setBigUint64` would write,
 * without converting a `number` timestamp to `BigInt` on every tick.
 */
function writeUint64Number(
  view: DataView,
  byteOffset: number,
  value: number,
): void {
  view.setUint32(byteOffset, value % UINT32_BASE, true);
  view.setUint32(byteOffset + 4, Math.floor(value / UINT32_BASE), true);
}

export class WagerTickFrameWriter {
  private readonly scratch = new Uint8Array(WAGER_TICK_FRAME_BYTES);
  private readonly view = new DataView(this.scratch.buffer);

  /** Returns the internal view; it is overwritten by the next `write()`. */
  write(input: WagerTickInput): Uint8Array {
    decodeRouteWord(input.routeWord32);
    assertLineHundredths(input.lineHundredths);
    assertStakeCents(input.stakeCents);
    assertWagerId(input.wagerId);
    asWallEpochMs(input.wallEpochMs);

    this.view.setUint8(0, WAGER_TICK_MAGIC);
    this.view.setUint8(1, WAGER_TICK_VERSION);
    this.view.setUint8(2, WAGER_TICK_MESSAGE_TYPE);
    this.view.setUint8(3, 0);
    this.view.setUint32(4, input.routeWord32 >>> 0, true);
    this.view.setInt32(8, input.lineHundredths, true);
    this.view.setInt32(12, input.stakeCents, true);
    this.view.setBigUint64(16, input.wagerId, true);
    writeUint64Number(this.view, 24, input.wallEpochMs);
    return this.scratch;
  }
}

/** Allocating convenience wrapper; prefer a reused `WagerTickFrameWriter` on hot paths. */
export function packWagerTickFrame(input: WagerTickInput): Uint8Array {
  return new WagerTickFrameWriter().write(input).slice();
}

export function readWagerTickFrame(bytes: Uint8Array): WagerTickFrame {
  if (bytes.byteLength !== WAGER_TICK_FRAME_BYTES) {
    throw new WagerTickFrameError(
      "wrong_length",
      `expected ${WAGER_TICK_FRAME_BYTES} bytes, got ${bytes.byteLength}`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint8(0);
  if (magic !== WAGER_TICK_MAGIC) {
    throw new WagerTickFrameError(
      "invalid_magic",
      `expected 0x${WAGER_TICK_MAGIC.toString(16)}, got 0x${magic.toString(16)}`,
    );
  }
  const version = view.getUint8(1);
  if (version !== WAGER_TICK_VERSION) {
    throw new WagerTickFrameError(
      "unsupported_version",
      `expected ${WAGER_TICK_VERSION}, got ${version}`,
    );
  }
  const messageType = view.getUint8(2);
  if (messageType !== WAGER_TICK_MESSAGE_TYPE) {
    throw new WagerTickFrameError(
      "unknown_message_type",
      `expected ${WAGER_TICK_MESSAGE_TYPE}, got ${messageType}`,
    );
  }
  const reserved = view.getUint8(3);
  if (reserved !== 0) {
    throw new WagerTickFrameError(
      "non_zero_reserved",
      `reserved byte must be 0, got ${reserved}`,
    );
  }

  const routeWord32 = asBridgeChannelPackedWord32(view.getUint32(4, true));
  decodeRouteWord(routeWord32);

  const wallEpochMs =
    view.getUint32(24, true) + view.getUint32(28, true) * UINT32_BASE;

  return {
    routeWord32,
    lineHundredths: asLineHundredths(view.getInt32(8, true)),
    stakeCents: asCents(view.getInt32(12, true)),
    wagerId: view.getBigUint64(16, true),
    wallEpochMs: asWallEpochMs(wallEpochMs),
  };
}

export interface WagerTickBroadcastResult {
  readonly clients: number;
  readonly delivered: number;
  readonly skippedByBridgeMask: number;
  readonly backpressured: number;
  readonly dropped: number;
}

/**
 * Per-socket bridge authorization plus the 32-byte tick frame.
 *
 * A socket receives a tick only when the bit for the frame's bridge ordinal is set in
 * its mask, so a client authorized for Fantasy402 bridges never receives a Partner118
 * tick even though both share one hub. Backpressure and drop handling is delegated to
 * `sendNshFrameToSubscriber`, which pauses the socket on `-1`; pair that with
 * `resumeNshSubscriber(ws)` in `drain(ws)`.
 */
export class WagerTelemetryHub {
  private readonly clients = new Map<
    NshSubscriberSocket,
    TransportBridgeBitMask32
  >();
  private readonly writer = new WagerTickFrameWriter();

  add(
    socket: NshSubscriberSocket,
    allowedBridgesMask32: TransportBridgeBitMask32,
  ): void {
    this.clients.set(socket, allowedBridgesMask32);
  }

  remove(socket: NshSubscriberSocket): boolean {
    return this.clients.delete(socket);
  }

  get size(): number {
    return this.clients.size;
  }

  broadcastTick(input: WagerTickInput): WagerTickBroadcastResult {
    const route = decodeRouteWord(input.routeWord32);
    const bridgeBit = 1 << route.bridgeOrdinal4;
    // One copy per tick, shared by every socket: see the header note on send-queue retention.
    const frame = this.writer.write(input).slice();

    let delivered = 0;
    let skippedByBridgeMask = 0;
    let backpressured = 0;
    let dropped = 0;

    for (const [socket, mask] of this.clients) {
      if ((mask & bridgeBit) === 0) {
        skippedByBridgeMask++;
        continue;
      }
      const outcome = sendNshFrameToSubscriber(socket, frame);
      switch (outcome.disposition) {
        case "PUBLISHED":
          delivered++;
          break;
        case "BACKPRESSURED":
          backpressured++;
          break;
        case "DROPPED":
          dropped++;
          break;
        default: {
          const exhaustive: never = outcome.disposition;
          throw new Error(`unhandled disposition: ${String(exhaustive)}`);
        }
      }
    }

    return {
      clients: this.clients.size,
      delivered,
      skippedByBridgeMask,
      backpressured,
      dropped,
    };
  }
}
