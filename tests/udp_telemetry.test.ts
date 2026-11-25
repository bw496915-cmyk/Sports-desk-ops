/**
 * @file tests/udp_telemetry.test.ts
 * @description Codec (CRC32 + DataView), sequence tracking, fan-out, multicast, and loopback tests for `src/lib/udp_telemetry.ts`.
 */

import { describe, expect, test } from "bun:test";

import {
  type BlobStore,
  createBlobLiveBetsServer,
} from "../services/blob_and_live_bets_server.ts";
import {
  createUdpTelemetryFanoutPublisher,
  createUdpTelemetryPublisher,
  createUdpTelemetryReceiver,
  decodeUdpTelemetryFrame,
  encodeUdpTelemetryFrame,
  encodeUdpTelemetryFrameInto,
  MAX_UDP_DATAGRAM_BYTES,
  UDP_TELEMETRY_OVERHEAD_BYTES,
  UdpPeerSequenceTracker,
  type UdpTelemetryDelivery,
} from "../src/lib/udp_telemetry.ts";

describe("UDP telemetry binary wire codec + CRC32", () => {
  test("round-trips big-endian header, UTF-8 payload, and Bun.hash.crc32 trailer", () => {
    const ts = 1_795_540_000_123;
    const payload = "TICK:L23.N0412:RF2003:+$20000";
    const encoded = encodeUdpTelemetryFrame({
      kind: "volume_ping",
      seq: 42,
      timestampMs: ts,
      flags: 0x00a5,
      payload,
    });

    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(encoded)).toBe(false);
    expect(encoded.byteLength).toBe(
      UDP_TELEMETRY_OVERHEAD_BYTES + Buffer.byteLength(payload),
    );

    const decoded = decodeUdpTelemetryFrame(encoded, { truncated: false });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.frame).toMatchObject({
      kind: "volume_ping",
      seq: 42,
      timestampMs: ts,
      flags: 0x00a5,
      payload,
    });
    expect(decoded.frame.crc32).toBeGreaterThan(0);
  });

  test("fails closed on MSG_TRUNC, bad magic, version, kind, length, 1-bit CRC32 flip, and MTU overflow", () => {
    const valid = encodeUdpTelemetryFrame({
      kind: "tick",
      seq: 1,
      payload: "NFL:1Q:-0.5",
    });

    expect(decodeUdpTelemetryFrame(valid, { truncated: true })).toEqual({
      ok: false,
      reason: "truncated",
    });
    expect(decodeUdpTelemetryFrame(new Uint8Array(8))).toEqual({
      ok: false,
      reason: "too_short",
    });

    const badMagic = valid.slice();
    badMagic[0] = 0x00;
    expect(decodeUdpTelemetryFrame(badMagic)).toEqual({
      ok: false,
      reason: "bad_magic",
    });

    const badVersion = valid.slice();
    badVersion[4] = 99;
    expect(decodeUdpTelemetryFrame(badVersion)).toEqual({
      ok: false,
      reason: "unsupported_version",
    });

    const badKind = valid.slice();
    badKind[5] = 250;
    expect(decodeUdpTelemetryFrame(badKind)).toEqual({
      ok: false,
      reason: "bad_kind",
    });

    const badLen = valid.slice(0, valid.byteLength - 1);
    expect(decodeUdpTelemetryFrame(badLen)).toEqual({
      ok: false,
      reason: "length_mismatch",
    });

    // Flip 1 bit in the payload -> CRC32 must catch it.
    const flippedPayload = valid.slice();
    flippedPayload[25] = (flippedPayload[25] ?? 0) ^ 0x01;
    expect(decodeUdpTelemetryFrame(flippedPayload)).toEqual({
      ok: false,
      reason: "bad_crc",
    });

    // Flip 1 bit in the sequence header -> CRC32 must catch it.
    const flippedHeader = valid.slice();
    flippedHeader[11] = (flippedHeader[11] ?? 0) ^ 0x80;
    expect(decodeUdpTelemetryFrame(flippedHeader)).toEqual({
      ok: false,
      reason: "bad_crc",
    });

    expect(() =>
      encodeUdpTelemetryFrame({
        kind: "alert",
        seq: 2,
        payload: "x".repeat(MAX_UDP_DATAGRAM_BYTES),
      }),
    ).toThrow(/ERR_UDP_FRAME_TOO_LARGE/);
  });

  test("UdpPeerSequenceTracker detects gaps, duplicates, out-of-order, and bounds tracked peers", () => {
    const tracker = new UdpPeerSequenceTracker(2);
    expect(tracker.observe("127.0.0.1:5000", 1)).toEqual({
      status: "in_order",
      gap: 0,
    });
    expect(tracker.observe("127.0.0.1:5000", 2)).toEqual({
      status: "in_order",
      gap: 0,
    });
    expect(tracker.observe("127.0.0.1:5000", 5)).toEqual({
      status: "gap",
      gap: 2,
    });
    expect(tracker.observe("127.0.0.1:5000", 5)).toEqual({
      status: "duplicate",
      gap: 0,
    });
    expect(tracker.observe("127.0.0.1:5000", 4)).toEqual({
      status: "out_of_order",
      gap: 0,
    });

    tracker.observe("127.0.0.1:5001", 1);
    tracker.observe("127.0.0.1:5002", 1);
    expect(tracker.peerCount).toBe(2);

    // RFC 1982 u32 wrap-around + 64-bit replay bitmap (late duplicate vs true out-of-order).
    const wrapTracker = new UdpPeerSequenceTracker(4);
    expect(wrapTracker.observe("p", 0xffff_fffe)).toEqual({
      status: "in_order",
      gap: 0,
    });
    expect(wrapTracker.observe("p", 0xffff_ffff)).toEqual({
      status: "in_order",
      gap: 0,
    });
    expect(wrapTracker.observe("p", 0)).toEqual({
      status: "in_order",
      gap: 0,
    });
    expect(wrapTracker.observe("p", 3)).toEqual({ status: "gap", gap: 2 });
    // First arrival of missing seq 1 is out_of_order; second arrival is a true duplicate.
    expect(wrapTracker.observe("p", 1)).toEqual({
      status: "out_of_order",
      gap: 0,
    });
    expect(wrapTracker.observe("p", 1)).toEqual({
      status: "duplicate",
      gap: 0,
    });
  });

  test("encodeUdpTelemetryFrameInto encodes zero-alloc into caller scratch buffer", () => {
    const scratch = new Uint8Array(MAX_UDP_DATAGRAM_BYTES);
    const view = encodeUdpTelemetryFrameInto(scratch, {
      kind: "alert",
      seq: 77,
      timestampMs: 1_795_540_001_000,
      flags: 0x0003,
      payload: "SCRATCH:OK",
    });
    expect(view.buffer).toBe(scratch.buffer);
    const decoded = decodeUdpTelemetryFrame(view);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.frame).toMatchObject({
      kind: "alert",
      seq: 77,
      flags: 0x0003,
      payload: "SCRATCH:OK",
    });

    expect(() =>
      encodeUdpTelemetryFrameInto(new Uint8Array(12), {
        kind: "tick",
        seq: 1,
        payload: "x",
      }),
    ).toThrow(/ERR_UDP_BUFFER_TOO_SMALL/);
  });
});

describe("UDP telemetry publisher, fan-out, multicast, and receiver loopback", () => {
  test("batches frames via connected sendMany(), tracks seq gaps/CRC drops, enforces queue cap, and supports reload()", async () => {
    const received: UdpTelemetryDelivery[] = [];
    const reloaded: UdpTelemetryDelivery[] = [];
    const dropped: string[] = [];

    let settleBatch: (() => void) | undefined;
    const batchDone = new Promise<void>((resolve) => {
      settleBatch = resolve;
    });
    const checkBatchDone = (): void => {
      if (received.length === 4 && dropped.length === 2) settleBatch?.();
    };
    let settleReloaded: (() => void) | undefined;
    const reloadedDone = new Promise<void>((resolve) => {
      settleReloaded = resolve;
    });

    using receiver = await createUdpTelemetryReceiver({
      hostname: "127.0.0.1",
      port: 0,
      onFrame(delivery) {
        received.push(delivery);
        checkBatchDone();
      },
      onDrop(reason) {
        dropped.push(reason);
        checkBatchDone();
      },
    });

    using publisher = await createUdpTelemetryPublisher({
      targetHost: "127.0.0.1",
      targetPort: receiver.port,
      batchSize: 8,
      maxQueueSize: 6,
      ttl: 64,
    });

    expect(receiver.socket.binaryType).toBe("uint8array");
    expect(publisher.socket.binaryType).toBe("uint8array");

    // 4 valid frames with a deliberate seq gap (1 -> 4), duplicate (4), out-of-order (3)
    // + 1 too_short + 1 corrupted CRC datagram -> 6 items (fills cap); 7th drops over cap.
    const corrupt = encodeUdpTelemetryFrame({
      kind: "tick",
      seq: 99,
      payload: "corrupt-me",
    });
    corrupt[26] = (corrupt[26] ?? 0) ^ 0xff;

    expect(publisher.enqueue({ kind: "tick", seq: 1, payload: "s1" })).toBe(
      true,
    );
    expect(
      publisher.enqueue({ kind: "volume_ping", seq: 4, payload: "s4-gap" }),
    ).toBe(true);
    expect(
      publisher.enqueue({ kind: "heartbeat", seq: 4, payload: "s4-dup" }),
    ).toBe(true);
    expect(publisher.enqueue({ kind: "tick", seq: 3, payload: "s3-ooo" })).toBe(
      true,
    );
    expect(publisher.enqueueRaw(new Uint8Array([1, 2, 3, 4]))).toBe(true);
    expect(publisher.enqueueRaw(corrupt)).toBe(true);
    expect(
      publisher.enqueue({ kind: "alert", seq: 5, payload: "over-cap" }),
    ).toBe(false);

    expect(publisher.flush()).toBe(6);
    await Promise.race([
      batchDone,
      Bun.sleep(2_000).then(() => {
        throw new Error("UDP telemetry batch timeout");
      }),
    ]);

    expect(
      received.map((d) => `${d.frame.seq}:${d.seqStatus}:${d.seqGap}`),
    ).toEqual(["1:in_order:0", "4:gap:2", "4:duplicate:0", "3:out_of_order:0"]);
    expect(dropped.sort()).toEqual(["bad_crc", "too_short"]);

    // Hot-reload receiver callback without rebinding socket.
    receiver.reloadOnFrame((delivery) => {
      reloaded.push(delivery);
      settleReloaded?.();
    });
    publisher.enqueue({ kind: "alert", seq: 5, payload: "STEAM:GSLIVE" });
    expect(publisher.flush()).toBe(1);

    await Promise.race([
      reloadedDone,
      Bun.sleep(2_000).then(() => {
        throw new Error("UDP telemetry reloaded handler timeout");
      }),
    ]);

    expect(reloaded[0]?.frame.payload).toBe("STEAM:GSLIVE");

    const pubStats = publisher.getStats();
    expect(pubStats.sentPackets).toBe(7);
    expect(pubStats.droppedOverCap).toBe(1);

    const rxStats = receiver.getStats();
    expect(rxStats.receivedPackets).toBe(7);
    expect(rxStats.decodedFrames).toBe(5);
    expect(rxStats.malformedPackets).toBe(1);
    expect(rxStats.crcFailures).toBe(1);
    expect(rxStats.sequenceGaps).toBe(1);
    expect(rxStats.missingPackets).toBe(2);
    expect(rxStats.duplicatePackets).toBe(1);
    expect(rxStats.outOfOrderPackets).toBe(1);
    expect(rxStats.trackedPeers).toBe(1);
  });

  test("fan-out publisher delivers one encoded frame to multiple peers + multicast group in batched sendMany()", async () => {
    const group = "239.255.77.78";
    const gotA: string[] = [];
    const gotB: string[] = [];
    const gotMcast: string[] = [];

    let settleAll: (() => void) | undefined;
    const allDone = new Promise<void>((r) => {
      settleAll = r;
    });
    const checkDone = (): void => {
      if (gotA.length === 1 && gotB.length === 1 && gotMcast.length === 1) {
        settleAll?.();
      }
    };

    using rxA = await createUdpTelemetryReceiver({
      hostname: "127.0.0.1",
      port: 0,
      onFrame(d) {
        gotA.push(d.frame.payload);
        checkDone();
      },
    });
    using rxB = await createUdpTelemetryReceiver({
      hostname: "127.0.0.1",
      port: 0,
      onFrame(d) {
        gotB.push(d.frame.payload);
        checkDone();
      },
    });
    using rxMcast = await createUdpTelemetryReceiver({
      hostname: "0.0.0.0",
      port: 0,
      multicastGroups: [{ group, interfaceAddress: "127.0.0.1" }],
      onFrame(d) {
        gotMcast.push(d.frame.payload);
        checkDone();
      },
    });

    using fanout = await createUdpTelemetryFanoutPublisher({
      bindHost: "127.0.0.1",
      peers: [
        { address: "127.0.0.1", port: rxA.port },
        { address: "127.0.0.1", port: rxB.port },
        { address: group, port: rxMcast.port },
      ],
      multicastTTL: 1,
      multicastLoopback: true,
      multicastInterface: "127.0.0.1",
    });

    expect(
      fanout.broadcastFrame({
        kind: "tick",
        payload: "FANOUT:NBA:Q1:-2.5",
      }),
    ).toBe(3);

    await Promise.race([
      allDone,
      Bun.sleep(2_000).then(() => {
        throw new Error("UDP fan-out + multicast timeout");
      }),
    ]);

    expect(gotA).toEqual(["FANOUT:NBA:Q1:-2.5"]);
    expect(gotB).toEqual(["FANOUT:NBA:Q1:-2.5"]);
    expect(gotMcast).toEqual(["FANOUT:NBA:Q1:-2.5"]);
    expect(rxMcast.leaveMulticast(group, "127.0.0.1")).toBe(true);
    expect(fanout.getStats().sentPackets).toBe(3);

    // Custom Bun.inspect compact (depth=0) and detailed summaries.
    expect(Bun.inspect(fanout, { depth: 0, colors: false })).toContain(
      "UdpTelemetryFanoutPublisher(peers=3 sent=3",
    );
    expect(Bun.inspect(rxA, { depth: 0, colors: false })).toContain(
      "UdpTelemetryReceiver(",
    );
  });

  test("createBlobLiveBetsServer mirrors publish() and POST /api/v1/live-bets to optional udpTelemetry sink", async () => {
    const deliveries: UdpTelemetryDelivery[] = [];
    let settle: (() => void) | undefined;
    const bothReceived = new Promise<void>((r) => {
      settle = r;
    });

    using rx = await createUdpTelemetryReceiver({
      hostname: "127.0.0.1",
      port: 0,
      onFrame(d) {
        deliveries.push(d);
        if (deliveries.length === 2) settle?.();
      },
    });
    using tx = await createUdpTelemetryPublisher({
      targetHost: "127.0.0.1",
      targetPort: rx.port,
      batchSize: 1,
    });

    const emptyStore: BlobStore = {
      async put() {
        return { bytesWritten: 0 };
      },
      presignGet: () => "https://example.invalid/blob",
      async exists() {
        return false;
      },
      async stat() {
        return { size: 0, contentType: "application/octet-stream" };
      },
      async getResponse() {
        return new Response(null, { status: 404 });
      },
      async delete() {},
    };

    const gateway = createBlobLiveBetsServer({
      blobs: emptyStore,
      apiToken: "udp-test-token",
      ticketSecret: "udp-test-secret",
      port: 0,
      hostname: "127.0.0.1",
      udpTelemetry: tx,
    });

    try {
      // 1. Programmatic publish() -> alert kind
      gateway.publish("syndicate-alerts", { id: "A1", edgeBps: 420 });

      // 2. HTTP POST /api/v1/live-bets -> volume_ping kind
      const postRes = await fetch(
        `http://127.0.0.1:${gateway.server.port}/api/v1/live-bets`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer udp-test-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            channel: "f402-pending",
            event: { tickets: 7 },
          }),
        },
      );
      expect(postRes.status).toBe(202);

      await Promise.race([
        bothReceived,
        Bun.sleep(2_000).then(() => {
          throw new Error("live-bets UDP mirror timeout");
        }),
      ]);

      expect(deliveries.map((d) => d.frame.kind)).toEqual([
        "alert",
        "volume_ping",
      ]);
      expect(deliveries[0]?.frame.payload).toBe(
        'syndicate-alerts:{"id":"A1","edgeBps":420}',
      );
      expect(deliveries[1]?.frame.payload).toBe('f402-pending:{"tickets":7}');

      const healthRes = await fetch(
        `http://127.0.0.1:${gateway.server.port}/health`,
      );
      const health = (await healthRes.json()) as {
        udpTelemetry?: { sentPackets?: number };
      };
      expect(health.udpTelemetry?.sentPackets).toBe(2);
    } finally {
      gateway.close(true);
    }
  });
});
