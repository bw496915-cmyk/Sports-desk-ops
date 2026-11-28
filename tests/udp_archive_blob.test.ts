/**
 * @file tests/udp_archive_blob.test.ts
 * @description Tests for binary UDP capture streams, compressed `Bun.Archive` Blobs,
 * fail-closed SHA-256/CRC32/tar tamper rejection, and live UDP → `BlobStore` archival.
 */

import { describe, expect, test } from "bun:test";

import { ARCHIVE_COMPRESS } from "../lib/archive_policy.ts";
import { MemoryBlobStore } from "../services/blob_and_live_bets_server.ts";
import {
  buildUdpArchiveBlob,
  createUdpArchiveRecorder,
  packUdpBinaryStream,
  readUdpArchiveBlob,
  UDP_ARCHIVE_CONTENT_TYPE,
  unpackUdpBinaryStream,
} from "../src/lib/udp_archive_blob.ts";
import {
  createUdpTelemetryPublisher,
  createUdpTelemetryReceiver,
  encodeUdpTelemetryFrame,
} from "../src/lib/udp_telemetry.ts";

describe("UDP binary capture stream & Bun.Archive Blob", () => {
  test("packUdpBinaryStream / unpackUdpBinaryStream round-trips IPv4 and IPv6 records and rejects corruption", () => {
    const f1 = encodeUdpTelemetryFrame({
      kind: "tick",
      seq: 1,
      timestampMs: 1_795_540_000_000,
      payload: "NFL:1Q:-0.5",
    });
    const f2 = encodeUdpTelemetryFrame({
      kind: "alert",
      seq: 2,
      timestampMs: 1_795_540_000_500,
      payload: "STEAM:GSLIVE",
    });

    const packed = packUdpBinaryStream([
      {
        receivedAtMs: 1_795_540_000_010,
        address: "127.0.0.1",
        port: 41234,
        ipv6: false,
        rawFrame: f1,
      },
      {
        receivedAtMs: 1_795_540_000_510,
        address: "::1",
        port: 41235,
        ipv6: true,
        rawFrame: f2,
      },
    ]);

    const unpacked = unpackUdpBinaryStream(packed);
    expect(unpacked).toHaveLength(2);
    expect(unpacked[0]?.address).toBe("127.0.0.1");
    expect(unpacked[0]?.ipv6).toBe(false);
    expect(unpacked[0]?.frame.payload).toBe("NFL:1Q:-0.5");
    expect(unpacked[1]?.address).toBe("::1");
    expect(unpacked[1]?.ipv6).toBe(true);
    expect(unpacked[1]?.frame.payload).toBe("STEAM:GSLIVE");

    // Flip 1 bit inside the embedded SDUP payload -> CRC32 fails closed on unpack.
    const corrupted = packed.slice();
    corrupted[corrupted.byteLength - 6] =
      (corrupted[corrupted.byteLength - 6] ?? 0) ^ 0x01;
    expect(() => unpackUdpBinaryStream(corrupted)).toThrow(
      /ERR_UDP_ARCHIVE_FRAME_INVALID:bad_crc/,
    );
  });

  test("buildUdpArchiveBlob produces gzip Bun.Archive Blob with separate window vs publish timestamps and verifies on read", async () => {
    const rawFrame = encodeUdpTelemetryFrame({
      kind: "volume_ping",
      seq: 10,
      timestampMs: 1_795_540_000_000,
      payload: "VOL:+$25000",
    });

    const built = await buildUdpArchiveBlob(
      [
        {
          receivedAtMs: 1_795_540_000_100,
          address: "127.0.0.1",
          port: 50001,
          ipv6: false,
          rawFrame,
        },
      ],
      { publishedAtMs: 1_795_540_060_000 },
    );

    expect(built.blob).toBeInstanceOf(Blob);
    expect(built.blob.type).toBe(UDP_ARCHIVE_CONTENT_TYPE);
    expect(built.blob.size).toBe(built.compressedBytes);
    // Verify gzip magic header (1f 8b)
    expect(built.bytes[0]).toBe(0x1f);
    expect(built.bytes[1]).toBe(0x8b);
    expect(built.manifest.windowStartMs).toBe(1_795_540_000_100);
    expect(built.manifest.windowEndMs).toBe(1_795_540_000_100);
    expect(built.manifest.publishedAtMs).toBe(1_795_540_060_000);

    const verified = await readUdpArchiveBlob(built.blob);
    expect(verified.sha256).toBe(built.sha256);
    expect(verified.records).toHaveLength(1);
    expect(verified.records[0]?.frame.seq).toBe(10);
    expect(verified.records[0]?.frame.payload).toBe("VOL:+$25000");
  });

  test("readUdpArchiveBlob fails closed on member SHA-256 tamper or unsafe tar traversal", async () => {
    const frame = encodeUdpTelemetryFrame({
      kind: "tick",
      seq: 1,
      payload: "CLEAN",
    });
    const built = await buildUdpArchiveBlob([
      {
        receivedAtMs: 1_795_540_000_000,
        address: "127.0.0.1",
        port: 9000,
        ipv6: false,
        rawFrame: frame,
      },
    ]);

    // Repackage with original manifest but tampered frames.sdup.bin -> must fail hash check.
    const files = await new Bun.Archive(built.bytes).files();
    const manifestBytes = new Uint8Array(
      await files.get("manifest.json")!.arrayBuffer(),
    );
    const jsonlBytes = new Uint8Array(
      await files.get("frames.jsonl")!.arrayBuffer(),
    );
    const tamperedBin = new Uint8Array(
      await files.get("frames.sdup.bin")!.arrayBuffer(),
    );
    tamperedBin[tamperedBin.byteLength - 1] =
      (tamperedBin[tamperedBin.byteLength - 1] ?? 0) ^ 0xff;

    const tamperedArchive = await new Bun.Archive(
      {
        "manifest.json": manifestBytes,
        "frames.sdup.bin": tamperedBin,
        "frames.jsonl": jsonlBytes,
      },
      ARCHIVE_COMPRESS,
    ).bytes();

    await expect(readUdpArchiveBlob(tamperedArchive)).rejects.toThrow(
      /ERR_ARCHIVE_HASH_MISMATCH:frames\.sdup\.bin/,
    );

    // Unsafe tar path traversal entry must be rejected by assertSafeTarGz.
    const hostileArchive = await new Bun.Archive(
      {
        "../evil.txt": "nope",
        "manifest.json": manifestBytes,
      },
      ARCHIVE_COMPRESS,
    ).bytes();
    await expect(readUdpArchiveBlob(hostileArchive)).rejects.toThrow(
      /unsafe tar entry/,
    );
  });

  test("end-to-end live UDP -> UdpArchiveRecorder -> BlobStore -> readUdpArchiveBlob", async () => {
    let clock = 1_795_540_100_000;
    const recorder = createUdpArchiveRecorder({
      maxBufferedFrames: 100,
      nowMs: () => (clock += 50),
    });
    const store = new MemoryBlobStore();

    let settle: (() => void) | undefined;
    const allReceived = new Promise<void>((r) => {
      settle = r;
    });

    using receiver = await createUdpTelemetryReceiver({
      hostname: "127.0.0.1",
      port: 0,
      onFrame(delivery) {
        recorder.recordDelivery(delivery);
        if (recorder.bufferedFrames === 3) settle?.();
      },
    });
    using publisher = await createUdpTelemetryPublisher({
      targetHost: "127.0.0.1",
      targetPort: receiver.port,
      batchSize: 8,
    });

    publisher.enqueue({ kind: "tick", payload: "LIVE:1" });
    publisher.enqueue({ kind: "volume_ping", payload: "LIVE:2" });
    publisher.enqueue({ kind: "alert", payload: "LIVE:3" });
    expect(publisher.flush()).toBe(3);

    await Promise.race([
      allReceived,
      Bun.sleep(2_000).then(() => {
        throw new Error("live UDP archive capture timeout");
      }),
    ]);

    expect(Bun.inspect(recorder, { depth: 0, colors: false })).toContain(
      "UdpArchiveRecorder(frames=3",
    );

    const flushed = await recorder.flushToBlobStore(
      store,
      "udp-telemetry/2026-11-25/batch-001.tar.gz",
      receiver.getStats(),
    );
    expect(recorder.bufferedFrames).toBe(0);
    expect(flushed.bytesWritten).toBe(flushed.archive.compressedBytes);
    expect(flushed.archive.manifest.receiverStats?.decodedFrames).toBe(3);

    // Fetch back through BlobStore HTTP Response -> Blob -> verified archive replay.
    const storedRes = await store.getResponse(flushed.key);
    expect(storedRes.headers.get("content-type")).toBe(
      UDP_ARCHIVE_CONTENT_TYPE,
    );
    const replayed = await readUdpArchiveBlob(await storedRes.blob());
    expect(replayed.sha256).toBe(flushed.archive.sha256);
    expect(replayed.records.map((r) => r.frame.payload)).toEqual([
      "LIVE:1",
      "LIVE:2",
      "LIVE:3",
    ]);
    expect(replayed.manifest.windowStartMs).toBeLessThan(
      replayed.manifest.windowEndMs ?? 0,
    );
  });
});
