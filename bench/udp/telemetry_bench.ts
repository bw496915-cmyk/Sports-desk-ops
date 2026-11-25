#!/usr/bin/env bun
/**
 * @file bench/udp/telemetry_bench.ts
 * @description Permanent Bun 1.4.5 microbenchmark for `src/lib/udp_telemetry.ts` (Compute + Loopback I/O).
 *
 * Separates Compute (`encodeUdpTelemetryFrame` vs zero-alloc `encodeUdpTelemetryFrameInto` + CRC32 decode)
 * from Loopback I/O (batched `sendMany(32)` vs single `send()`).
 *
 * Run: bun bench/udp/telemetry_bench.ts
 */

import {
  createUdpTelemetryPublisher,
  createUdpTelemetryReceiver,
  decodeUdpTelemetryFrame,
  encodeUdpTelemetryFrame,
  encodeUdpTelemetryFrameInto,
  MAX_UDP_DATAGRAM_BYTES,
} from "../../src/lib/udp_telemetry.ts";

const SAMPLE_PAYLOAD =
  '{"channel":"f402-bet-ticker","kind":"tick","league":"NFL","period":"1Q","spread":-0.5,"total":8.5,"riskCents":250000}';
const COMPUTE_ITERS = 100_000;
const IO_PACKETS = 4_096;

function benchCompute(label: string, iters: number, fn: () => number): void {
  // Warmup
  for (let i = 0; i < 2_000; i++) fn();
  let totalBytes = 0;
  const t0 = Bun.nanoseconds();
  for (let i = 0; i < iters; i++) {
    totalBytes += fn();
  }
  const elapsedNs = Bun.nanoseconds() - t0;
  const elapsedSec = elapsedNs / 1e9;
  const opsPerSec = Math.round(iters / elapsedSec);
  const nsPerOp = elapsedNs / iters;
  const mbPerSec = totalBytes / (1024 * 1024) / elapsedSec;
  console.log(
    `[compute] ${label.padEnd(36)} ${opsPerSec.toLocaleString().padStart(11)} ops/s | ${nsPerOp.toFixed(1).padStart(7)} ns/op | ${mbPerSec.toFixed(1).padStart(7)} MB/s`,
  );
}

console.log(
  `UDP Telemetry Benchmark · Bun ${Bun.version} · payload=${Buffer.byteLength(SAMPLE_PAYLOAD)}B`,
);

let seq = 1;
benchCompute("encode (alloc + crc32)", COMPUTE_ITERS, () => {
  const frame = encodeUdpTelemetryFrame({
    kind: "tick",
    seq: seq++,
    payload: SAMPLE_PAYLOAD,
  });
  return frame.byteLength;
});

const scratch = new Uint8Array(MAX_UDP_DATAGRAM_BYTES);
benchCompute("encodeInto (zero-alloc + crc32)", COMPUTE_ITERS, () => {
  const frame = encodeUdpTelemetryFrameInto(scratch, {
    kind: "tick",
    seq: seq++,
    payload: SAMPLE_PAYLOAD,
  });
  return frame.byteLength;
});

const preEncoded = encodeUdpTelemetryFrame({
  kind: "tick",
  seq: 1,
  payload: SAMPLE_PAYLOAD,
});
benchCompute("decode (DataView + crc32 + UTF8)", COMPUTE_ITERS, () => {
  const decoded = decodeUdpTelemetryFrame(preEncoded, { truncated: false });
  return decoded.ok ? preEncoded.byteLength : 0;
});

// Loopback I/O replica: batched sendMany(32) vs single send().
{
  let received = 0;
  using rx = await createUdpTelemetryReceiver({
    hostname: "127.0.0.1",
    port: 0,
    onFrame() {
      received += 1;
    },
  });
  using tx = await createUdpTelemetryPublisher({
    targetHost: "127.0.0.1",
    targetPort: rx.port,
    batchSize: 32,
    maxQueueSize: 512,
  });
  const t0 = Bun.nanoseconds();
  let sent = 0;
  for (let i = 0; i < IO_PACKETS; i++) {
    tx.enqueueRaw(preEncoded);
  }
  tx.flush();
  sent = tx.getStats().sentPackets;
  const elapsedMs = (Bun.nanoseconds() - t0) / 1e6;
  await Bun.sleep(25);
  console.log(
    `[io]      ${"connected sendMany(batch=32)".padEnd(36)} ${Math.round(
      sent / (elapsedMs / 1000),
    )
      .toLocaleString()
      .padStart(
        11,
      )} pkt/s | sent=${sent} rx=${received} (${elapsedMs.toFixed(2)}ms)`,
  );
}
