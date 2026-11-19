/**
 * @file tests/wager_telemetry_hub.test.ts
 * @description Contract tests for the 32-byte wager-tick frame and the
 * bridge-authorized WebSocket fan-out.
 *
 * The isolation cases use two real transport bridges whose ordinals come from
 * `TRANSPORT_BRIDGE_SPECIFICATION_TABLE` (F402 ticker = 1, P118 tally = 3), and
 * route words produced by `encodeBridgeChannelPackedWord32`, so the fixture cannot
 * drift from the incidence matrix the production path enforces.
 */

import { describe, expect, test } from "bun:test";
import type { EpochMs } from "../design/domain-branded-types.ts";
import { asBridgeChannelPackedWord32 } from "../design/domain-branded-types.ts";
import {
  asCents,
  asLineHundredths,
  asTransportBridgeBitMask32,
  encodeBridgeChannelPackedWord32,
} from "../lib/bridge_and_channel_router.ts";
import type { NshSubscriberSocket } from "../lib/nsh_frame_codec.ts";
import {
  asWallEpochMs,
  packWagerTickFrame,
  readWagerTickFrame,
  WAGER_TICK_FRAME_BYTES,
  WagerTickFrameError,
  WagerTelemetryHub,
  type WagerTickFrameErrorCode,
  type WagerTickInput,
} from "../lib/wager_telemetry_hub.ts";

const F402_ROUTE = encodeBridgeChannelPackedWord32(
  "BRIDGE_01_F402_BET_TICKER_STREAM",
  "GSLIVE",
);
const P118_ROUTE = encodeBridgeChannelPackedWord32(
  "BRIDGE_03_GSLIVE_PARTNER118_TALLY",
  "GSLIVE",
);
const F402_MASK = asTransportBridgeBitMask32(1 << 1);
const P118_MASK = asTransportBridgeBitMask32(1 << 3);
const EPOCH = asWallEpochMs(Date.UTC(2026, 10, 19, 23, 14, 43));

function tickInput(overrides: Partial<WagerTickInput> = {}): WagerTickInput {
  return {
    routeWord32: F402_ROUTE,
    lineHundredths: asLineHundredths(-1050),
    stakeCents: asCents(2_500),
    wagerId: 123_456_789_012_345n,
    wallEpochMs: EPOCH,
    ...overrides,
  };
}

function expectErrorCode(
  run: () => unknown,
  code: WagerTickFrameErrorCode,
): void {
  try {
    run();
  } catch (error) {
    if (!(error instanceof WagerTickFrameError)) throw error;
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected WagerTickFrameError "${code}"`);
}

class FakeSocket implements NshSubscriberSocket {
  readonly frames: Uint8Array[] = [];
  readonly compressFlags: Array<boolean | undefined> = [];
  pauses = 0;
  resumes = 0;

  constructor(private readonly sendStatus: number = 1) {}

  send(data: Uint8Array | ArrayBuffer, compress?: boolean): number {
    // Keep the reference, not a copy: the frame-stability case needs to see
    // whether the hub handed out its reusable scratch buffer.
    this.frames.push(data instanceof Uint8Array ? data : new Uint8Array(data));
    this.compressFlags.push(compress);
    return this.sendStatus;
  }

  pause(): void {
    this.pauses++;
  }

  resume(): void {
    this.resumes++;
  }
}

describe("wager tick frame", () => {
  test("packs the documented 32-byte little-endian layout", () => {
    const bytes = packWagerTickFrame(
      tickInput({ wagerId: 0x0102030405060708n }),
    );

    expect(bytes.byteLength).toBe(WAGER_TICK_FRAME_BYTES);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint8(0)).toBe(0x57);
    expect(view.getUint8(1)).toBe(1);
    expect(view.getUint8(2)).toBe(1);
    expect(view.getUint8(3)).toBe(0);
    expect(view.getUint32(4, true)).toBe(F402_ROUTE >>> 0);
    expect(view.getInt32(8, true)).toBe(-1050);
    expect(view.getInt32(12, true)).toBe(2_500);
    expect(view.getBigUint64(16, true)).toBe(0x0102030405060708n);
    expect(view.getBigUint64(24, true)).toBe(BigInt(EPOCH));
  });

  test("round-trips branded fields, including a negative line", () => {
    const input = tickInput({
      lineHundredths: asLineHundredths(-7_250),
      stakeCents: asCents(0x7fff_fffe),
      wagerId: 0xffff_ffff_ffff_ffffn,
      wallEpochMs: asWallEpochMs(2 ** 53 - 1),
    });

    const frame = readWagerTickFrame(packWagerTickFrame(input));

    expect(frame.routeWord32).toBe(input.routeWord32);
    expect(frame.lineHundredths).toBe(asLineHundredths(-7_250));
    expect(frame.stakeCents).toBe(asCents(0x7fff_fffe));
    expect(frame.wagerId).toBe(0xffff_ffff_ffff_ffffn);
    expect(frame.wallEpochMs).toBe(asWallEpochMs(2 ** 53 - 1));
  });

  test("rejects out-of-range and structurally invalid inputs at pack time", () => {
    expectErrorCode(
      () => packWagerTickFrame(tickInput({ lineHundredths: 1.5 as never })),
      "line_out_of_range",
    );
    expectErrorCode(
      () => packWagerTickFrame(tickInput({ stakeCents: -1 as never })),
      "stake_out_of_range",
    );
    expectErrorCode(
      () => packWagerTickFrame(tickInput({ wagerId: -1n })),
      "wager_id_out_of_range",
    );
    expectErrorCode(
      () =>
        packWagerTickFrame(
          tickInput({
            routeWord32: asBridgeChannelPackedWord32(0xffff_ffff),
          }),
        ),
      "invalid_route_word",
    );
    expectErrorCode(
      () =>
        packWagerTickFrame({
          ...tickInput(),
          routeWord32: asBridgeChannelPackedWord32(10 | (5 << 4)),
        }),
      "unknown_bridge_ordinal",
    );
    expectErrorCode(() => asWallEpochMs(2 ** 53), "epoch_ms_out_of_range");
    expectErrorCode(() => asWallEpochMs(-1), "epoch_ms_out_of_range");
    expectErrorCode(() => asWallEpochMs(Number.NaN), "epoch_ms_out_of_range");
  });

  test("rejects a malformed frame at read time", () => {
    const packed = packWagerTickFrame(tickInput());

    expectErrorCode(
      () => readWagerTickFrame(packed.slice(0, 31)),
      "wrong_length",
    );

    const cases: ReadonlyArray<
      readonly [number, number, WagerTickFrameErrorCode]
    > = [
      [0, 0, "invalid_magic"],
      [1, 2, "unsupported_version"],
      [2, 2, "unknown_message_type"],
      [3, 1, "non_zero_reserved"],
    ];
    for (const [offset, value, code] of cases) {
      const corrupted = packed.slice();
      corrupted[offset] = value;
      expectErrorCode(() => readWagerTickFrame(corrupted), code);
    }
  });

  test("decodes the same u64 bytes setBigUint64 writes for the epoch", () => {
    const epoch = asWallEpochMs(Date.UTC(2026, 0, 1));
    const view = new DataView(new ArrayBuffer(8));
    view.setBigUint64(0, BigInt(epoch), true);
    const packed = packWagerTickFrame(tickInput({ wallEpochMs: epoch }));
    expect(packed.slice(24, 32)).toEqual(
      new Uint8Array(view.buffer, 0, 8).slice(),
    );
  });
});

describe("WagerTelemetryHub", () => {
  test("delivers only to sockets whose bridge mask contains the frame bridge", () => {
    const hub = new WagerTelemetryHub();
    const f402 = new FakeSocket();
    const p118 = new FakeSocket();
    hub.add(f402, F402_MASK);
    hub.add(p118, P118_MASK);

    const result = hub.broadcastTick(tickInput());

    expect(result).toEqual({
      clients: 2,
      delivered: 1,
      skippedByBridgeMask: 1,
      backpressured: 0,
      dropped: 0,
    });
    expect(f402.frames).toHaveLength(1);
    expect(p118.frames).toHaveLength(0);
    expect(readWagerTickFrame(f402.frames[0]!).routeWord32).toBe(F402_ROUTE);
  });

  test("sends binary frames with compression disabled", () => {
    const hub = new WagerTelemetryHub();
    const socket = new FakeSocket();
    hub.add(socket, F402_MASK);

    hub.broadcastTick(tickInput());

    expect(socket.compressFlags).toEqual([false]);
  });

  test("counts backpressure and dropped sends separately", () => {
    const hub = new WagerTelemetryHub();
    const slow = new FakeSocket(-1);
    const full = new FakeSocket(0);
    hub.add(slow, F402_MASK);
    hub.add(full, F402_MASK);

    const result = hub.broadcastTick(tickInput());

    expect(result).toEqual({
      clients: 2,
      delivered: 0,
      skippedByBridgeMask: 0,
      backpressured: 1,
      dropped: 1,
    });
    expect(slow.pauses).toBe(1);
    expect(full.pauses).toBe(0);
  });

  test("does not reuse a frame buffer across ticks", () => {
    const hub = new WagerTelemetryHub();
    const socket = new FakeSocket();
    hub.add(socket, F402_MASK);

    hub.broadcastTick(tickInput({ wagerId: 1n }));
    hub.broadcastTick(tickInput({ wagerId: 2n }));

    expect(readWagerTickFrame(socket.frames[0]!).wagerId).toBe(1n);
    expect(readWagerTickFrame(socket.frames[1]!).wagerId).toBe(2n);
  });

  test("stops delivering after remove and reports an empty broadcast", () => {
    const hub = new WagerTelemetryHub();
    const socket = new FakeSocket();
    hub.add(socket, F402_MASK);
    expect(hub.size).toBe(1);

    expect(hub.remove(socket)).toBe(true);
    expect(hub.remove(socket)).toBe(false);
    expect(hub.size).toBe(0);

    expect(hub.broadcastTick(tickInput())).toEqual({
      clients: 0,
      delivered: 0,
      skippedByBridgeMask: 0,
      backpressured: 0,
      dropped: 0,
    });
    expect(socket.frames).toHaveLength(0);
  });

  test("keeps a P118 frame away from an F402-only client", () => {
    const hub = new WagerTelemetryHub();
    const f402 = new FakeSocket();
    hub.add(f402, F402_MASK);

    const result = hub.broadcastTick(tickInput({ routeWord32: P118_ROUTE }));

    expect(result.skippedByBridgeMask).toBe(1);
    expect(result.delivered).toBe(0);
    expect(f402.frames).toHaveLength(0);
  });
});

test("epoch brand accepts a valid millisecond instant", () => {
  const epoch: EpochMs = asWallEpochMs(1_763_000_000_000);
  expect(epoch).toBe(asWallEpochMs(1_763_000_000_000));
});
