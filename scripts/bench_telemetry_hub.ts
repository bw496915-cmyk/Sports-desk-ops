#!/usr/bin/env bun
/**
 * Times the wager-telemetry hot path: encode one 32-byte tick frame and fan it
 * out to bridge-authorized sockets. Run on an idle machine; a parallel test
 * runner would measure the runner.
 *
 *   bun run bench:telemetry
 */
import {
  asCents,
  asLineHundredths,
  asTransportBridgeBitMask32,
  encodeBridgeChannelPackedWord32,
} from "../lib/bridge_and_channel_router.ts";
import { asWallEpochMs } from "../lib/wager_telemetry_hub.ts";
import type { NshSubscriberSocket } from "../lib/nsh_frame_codec.ts";
import {
  packWagerTickFrame,
  WagerTickFrameWriter,
  WagerTelemetryHub,
  type WagerTickInput,
} from "../lib/wager_telemetry_hub.ts";

const F402_ROUTE = encodeBridgeChannelPackedWord32(
  "BRIDGE_01_F402_BET_TICKER_STREAM",
  "GSLIVE",
);
const F402_MASK = asTransportBridgeBitMask32(1 << 1);
const TICK: WagerTickInput = {
  routeWord32: F402_ROUTE,
  lineHundredths: asLineHundredths(-450),
  stakeCents: asCents(12_500),
  wagerId: 987_654_321_000n,
  wallEpochMs: asWallEpochMs(Date.UTC(2026, 10, 19, 23, 20, 2, 280)),
};

function fakeSocket(): NshSubscriberSocket {
  return {
    send: (frame: Uint8Array | ArrayBuffer, _compress?: boolean): number =>
      frame.byteLength,
    pause: (): void => undefined,
    resume: (): void => undefined,
  };
}

function hubWithSubscribers(count: number): WagerTelemetryHub {
  const hub = new WagerTelemetryHub();
  for (let index = 0; index < count; index += 1) {
    hub.add(fakeSocket(), F402_MASK);
  }
  return hub;
}

function measure(label: string, iterations: number, body: () => void): void {
  for (let index = 0; index < Math.min(1_000, iterations); index += 1) body();
  const startedAt = Bun.nanoseconds();
  for (let index = 0; index < iterations; index += 1) body();
  const elapsedMs = (Bun.nanoseconds() - startedAt) / 1e6;
  const perOpUs = (elapsedMs / iterations) * 1_000;
  const opsPerSecond = Math.round(iterations / (elapsedMs / 1_000));
  console.log(
    ` • ${label.padEnd(34)}: ${perOpUs.toFixed(3)} µs/op, ${opsPerSecond.toLocaleString("en-US")} ops/s`,
  );
}

console.log(`\n[Benchmark: wager telemetry] Bun v${Bun.version}`);
// Consume every result: an unused encode is optimized away and would report
// an implausibly fast, meaningless number.
let sink = 0;
const encodeIterations = 200_000;
measure("encode (public, new writer)", encodeIterations, () => {
  sink += packWagerTickFrame(TICK).byteLength;
});
const writer = new WagerTickFrameWriter();
measure("encode (reused writer)", encodeIterations, () => {
  sink += writer.write(TICK).slice().byteLength;
});

for (const subscribers of [1, 8, 64]) {
  const hub = hubWithSubscribers(subscribers);
  const iterations = subscribers === 64 ? 20_000 : 100_000;
  measure(`broadcast to ${subscribers} socket(s)`, iterations, () => {
    sink += hub.broadcastTick(TICK).delivered;
  });
}
console.log(` • checksum                        : ${sink}`);
