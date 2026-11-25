/**
 * @file src/lib/udp_archive_blob.ts
 * @description Binary UDP telemetry capture stream + compressed `Bun.Archive` `.tar.gz` Blob builder,
 * fail-closed integrity verifier (`assertSafeTarGz` + SHA-256 + `SDUP` CRC32), and `BlobStore` archiver.
 */

import { ARCHIVE_COMPRESS } from "../../lib/archive_policy.ts";
import { assertSafeTarGz, sha256HexBytes } from "../../lib/eod_archive.ts";
import type { BlobStore } from "../../services/blob_and_live_bets_server.ts";
import {
  type BinaryPayload,
  toDataView,
  toUint8ArrayView,
} from "./binary_type.ts";
import {
  decodeUdpTelemetryFrame,
  encodeUdpTelemetryFrame,
  type UdpTelemetryDelivery,
  type UdpTelemetryFrame,
  type UdpTelemetryReceiverStats,
} from "./udp_telemetry.ts";

/** ASCII "SDAB" magic header (`0x53444142`) for length-prefixed binary UDP capture streams. */
export const UDP_ARCHIVE_STREAM_MAGIC = 0x53444142;
export const UDP_ARCHIVE_STREAM_VERSION = 1;
export const UDP_ARCHIVE_SCHEMA_VERSION = 1;
export const UDP_ARCHIVE_CONTENT_TYPE = "application/gzip";

const STREAM_HEADER_BYTES = 8; // u32 magic + u8 version + u8 reserved + u16 reserved
const RECORD_FIXED_HEADER_BYTES = 16; // u32 recordLen + u64 receivedAtMs + u16 peerPort + u8 ipv6 + u8 peerIpLen

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();
const INSPECT_CUSTOM = Bun.inspect.custom;

export interface UdpCapturedRecordInput {
  readonly receivedAtMs: number;
  readonly address: string;
  readonly port: number;
  readonly ipv6: boolean;
  readonly rawFrame: Uint8Array;
}

export interface UdpCapturedRecord {
  readonly receivedAtMs: number;
  readonly address: string;
  readonly port: number;
  readonly ipv6: boolean;
  readonly rawFrame: Uint8Array;
  readonly frame: UdpTelemetryFrame;
}

/**
 * Packs raw CRC32-signed `SDUP` UDP datagrams into a contiguous length-prefixed binary stream
 * (`frames.sdup.bin`) with zero JSON overhead on the wire bytes.
 */
export function packUdpBinaryStream(
  records: readonly UdpCapturedRecordInput[],
): Uint8Array<ArrayBuffer> {
  const encodedIps: Uint8Array[] = [];
  let totalBytes = STREAM_HEADER_BYTES;

  for (const rec of records) {
    const ipBytes = UTF8_ENCODER.encode(rec.address);
    if (ipBytes.byteLength > 255) {
      throw new RangeError(
        `ERR_UDP_ARCHIVE_IP_TOO_LONG: peer address exceeds 255 bytes`,
      );
    }
    encodedIps.push(ipBytes);
    totalBytes +=
      RECORD_FIXED_HEADER_BYTES + ipBytes.byteLength + rec.rawFrame.byteLength;
  }

  const out = new Uint8Array(new ArrayBuffer(totalBytes));
  const view = new DataView(out.buffer);
  view.setUint32(0, UDP_ARCHIVE_STREAM_MAGIC, false);
  view.setUint8(4, UDP_ARCHIVE_STREAM_VERSION);
  view.setUint8(5, 0);
  view.setUint16(6, 0, false);

  let offset = STREAM_HEADER_BYTES;
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    const ipBytes = encodedIps[i]!;
    const payloadLen = ipBytes.byteLength + rec.rawFrame.byteLength;
    const recordLen = RECORD_FIXED_HEADER_BYTES + payloadLen;

    view.setUint32(offset, recordLen, false);
    view.setBigUint64(
      offset + 4,
      BigInt(Math.max(0, Math.trunc(rec.receivedAtMs))),
      false,
    );
    view.setUint16(offset + 12, rec.port & 0xffff, false);
    view.setUint8(offset + 14, rec.ipv6 ? 1 : 0);
    view.setUint8(offset + 15, ipBytes.byteLength);

    offset += RECORD_FIXED_HEADER_BYTES;
    out.set(ipBytes, offset);
    offset += ipBytes.byteLength;
    out.set(rec.rawFrame, offset);
    offset += rec.rawFrame.byteLength;
  }

  return out;
}

/**
 * Unpacks and CRC32-verifies every record in a `frames.sdup.bin` stream fail-closed.
 */
export function unpackUdpBinaryStream(
  raw: BinaryPayload | ArrayBufferView,
): UdpCapturedRecord[] {
  const bytes = toUint8ArrayView(raw);
  if (bytes.byteLength < STREAM_HEADER_BYTES) {
    throw new Error("ERR_UDP_ARCHIVE_STREAM_TOO_SHORT");
  }
  const view = toDataView(bytes);
  if (view.getUint32(0, false) !== UDP_ARCHIVE_STREAM_MAGIC) {
    throw new Error("ERR_UDP_ARCHIVE_STREAM_BAD_MAGIC");
  }
  if (view.getUint8(4) !== UDP_ARCHIVE_STREAM_VERSION) {
    throw new Error("ERR_UDP_ARCHIVE_STREAM_UNSUPPORTED_VERSION");
  }

  const records: UdpCapturedRecord[] = [];
  let offset = STREAM_HEADER_BYTES;
  while (offset < bytes.byteLength) {
    if (offset + RECORD_FIXED_HEADER_BYTES > bytes.byteLength) {
      throw new Error("ERR_UDP_ARCHIVE_RECORD_TRUNCATED");
    }
    const recordLen = view.getUint32(offset, false);
    if (
      recordLen < RECORD_FIXED_HEADER_BYTES ||
      offset + recordLen > bytes.byteLength
    ) {
      throw new Error("ERR_UDP_ARCHIVE_RECORD_LENGTH_INVALID");
    }

    const receivedAtMs = Number(view.getBigUint64(offset + 4, false));
    const port = view.getUint16(offset + 12, false);
    const ipv6 = view.getUint8(offset + 14) === 1;
    const ipLen = view.getUint8(offset + 15);
    const ipStart = offset + RECORD_FIXED_HEADER_BYTES;
    const frameStart = ipStart + ipLen;
    const recordEnd = offset + recordLen;
    if (frameStart > recordEnd) {
      throw new Error("ERR_UDP_ARCHIVE_RECORD_IP_BOUNDS");
    }

    const address = UTF8_DECODER.decode(bytes.subarray(ipStart, frameStart));
    const rawFrame = bytes.slice(frameStart, recordEnd);
    const decoded = decodeUdpTelemetryFrame(rawFrame);
    if (!decoded.ok) {
      throw new Error(`ERR_UDP_ARCHIVE_FRAME_INVALID:${decoded.reason}`);
    }

    records.push({
      receivedAtMs,
      address,
      port,
      ipv6,
      rawFrame,
      frame: decoded.frame,
    });
    offset = recordEnd;
  }

  return records;
}

export interface UdpArchiveManifest {
  readonly schemaVersion: typeof UDP_ARCHIVE_SCHEMA_VERSION;
  readonly codec: "sdup-v1-crc32";
  readonly compression: {
    readonly algorithm: "gzip";
    readonly level: number;
  };
  readonly frameCount: number;
  readonly binaryStreamBytes: number;
  readonly jsonlBytes: number;
  /** Data window boundaries (distinct from `publishedAtMs`). */
  readonly windowStartMs: number | null;
  readonly windowEndMs: number | null;
  readonly publishedAtMs: number;
  readonly members: {
    readonly binaryStream: {
      readonly path: "frames.sdup.bin";
      readonly sha256: string;
      readonly bytes: number;
    };
    readonly jsonlIndex: {
      readonly path: "frames.jsonl";
      readonly sha256: string;
      readonly bytes: number;
    };
  };
  readonly receiverStats?: UdpTelemetryReceiverStats;
}

export interface BuiltUdpArchiveBlob {
  readonly blob: Blob;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly sha256: string;
  readonly compressedBytes: number;
  readonly uncompressedBytes: number;
  readonly manifest: UdpArchiveManifest;
}

export interface BuildUdpArchiveOptions {
  readonly publishedAtMs?: number;
  readonly receiverStats?: UdpTelemetryReceiverStats;
}

/**
 * Builds a compressed `Bun.Archive` `.tar.gz` Blob (`application/gzip`) containing:
 * - `frames.sdup.bin`: length-prefixed binary UDP capture stream
 * - `frames.jsonl`: decoded JSONL index (streamable via `Bun.JSONL.parseChunk`)
 * - `manifest.json`: SHA-256 member digests, separate data-window vs publish timestamps, and stats
 */
export async function buildUdpArchiveBlob(
  records: readonly UdpCapturedRecordInput[],
  options: BuildUdpArchiveOptions = {},
): Promise<BuiltUdpArchiveBlob> {
  const binaryStream = packUdpBinaryStream(records);
  const decodedRecords = unpackUdpBinaryStream(binaryStream);

  let windowStartMs: number | null = null;
  let windowEndMs: number | null = null;
  const jsonlLines: string[] = [];

  for (const rec of decodedRecords) {
    if (windowStartMs === null || rec.receivedAtMs < windowStartMs) {
      windowStartMs = rec.receivedAtMs;
    }
    if (windowEndMs === null || rec.receivedAtMs > windowEndMs) {
      windowEndMs = rec.receivedAtMs;
    }
    jsonlLines.push(
      JSON.stringify({
        receivedAtMs: rec.receivedAtMs,
        address: rec.address,
        port: rec.port,
        ipv6: rec.ipv6,
        kind: rec.frame.kind,
        seq: rec.frame.seq,
        timestampMs: rec.frame.timestampMs,
        flags: rec.frame.flags,
        crc32: rec.frame.crc32,
        payload: rec.frame.payload,
      }),
    );
  }

  const jsonlBytes = UTF8_ENCODER.encode(
    jsonlLines.length === 0 ? "" : `${jsonlLines.join("\n")}\n`,
  );
  const binarySha = sha256HexBytes(binaryStream);
  const jsonlSha = sha256HexBytes(jsonlBytes);

  const manifest: UdpArchiveManifest = {
    schemaVersion: UDP_ARCHIVE_SCHEMA_VERSION,
    codec: "sdup-v1-crc32",
    compression: {
      algorithm: ARCHIVE_COMPRESS.compress,
      level: ARCHIVE_COMPRESS.level,
    },
    frameCount: decodedRecords.length,
    binaryStreamBytes: binaryStream.byteLength,
    jsonlBytes: jsonlBytes.byteLength,
    windowStartMs,
    windowEndMs,
    publishedAtMs: Math.trunc(options.publishedAtMs ?? Date.now()),
    members: {
      binaryStream: {
        path: "frames.sdup.bin",
        sha256: binarySha,
        bytes: binaryStream.byteLength,
      },
      jsonlIndex: {
        path: "frames.jsonl",
        sha256: jsonlSha,
        bytes: jsonlBytes.byteLength,
      },
    },
    ...(options.receiverStats === undefined
      ? {}
      : { receiverStats: options.receiverStats }),
  };

  const manifestBytes = UTF8_ENCODER.encode(
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  const archive = new Bun.Archive(
    {
      "manifest.json": manifestBytes,
      "frames.sdup.bin": binaryStream,
      "frames.jsonl": jsonlBytes,
    },
    ARCHIVE_COMPRESS,
  );
  const rawArchiveBytes = await archive.bytes();
  // Ensure plain ArrayBuffer backing so Blob/WebCrypto accept it under strict TS 7.
  const archiveBytes = new Uint8Array(
    new ArrayBuffer(rawArchiveBytes.byteLength),
  );
  archiveBytes.set(rawArchiveBytes);
  const blob = new Blob([archiveBytes], { type: UDP_ARCHIVE_CONTENT_TYPE });

  return {
    blob,
    bytes: archiveBytes,
    sha256: sha256HexBytes(archiveBytes),
    compressedBytes: archiveBytes.byteLength,
    uncompressedBytes:
      manifestBytes.byteLength +
      binaryStream.byteLength +
      jsonlBytes.byteLength,
    manifest,
  };
}

export interface ReadUdpArchiveResult {
  readonly manifest: UdpArchiveManifest;
  readonly records: readonly UdpCapturedRecord[];
  readonly sha256: string;
  readonly compressedBytes: number;
}

/**
 * Reads and verifies a UDP archive Blob/Uint8Array/ArrayBuffer fail-closed:
 * 1. Rejects unsafe tar links/paths via `assertSafeTarGz`
 * 2. Validates `manifest.json` schema and SHA-256 digests of `frames.sdup.bin` and `frames.jsonl`
 * 3. Re-decodes and CRC32-verifies every `SDUP` binary datagram in `frames.sdup.bin`
 */
export async function readUdpArchiveBlob(
  input: Blob | BinaryPayload | ArrayBufferView,
): Promise<ReadUdpArchiveResult> {
  const bytes =
    input instanceof Blob
      ? new Uint8Array(await input.arrayBuffer())
      : toUint8ArrayView(input);

  assertSafeTarGz(bytes);

  const files = await new Bun.Archive(bytes).files();
  const manifestFile = files.get("manifest.json");
  const binaryFile = files.get("frames.sdup.bin");
  const jsonlFile = files.get("frames.jsonl");
  if (!manifestFile || !binaryFile || !jsonlFile) {
    throw new Error("ERR_ARCHIVE_MISSING_REQUIRED_MEMBER");
  }

  const manifest = JSON.parse(await manifestFile.text()) as UdpArchiveManifest;
  if (
    manifest.schemaVersion !== UDP_ARCHIVE_SCHEMA_VERSION ||
    manifest.codec !== "sdup-v1-crc32"
  ) {
    throw new Error("ERR_ARCHIVE_UNSUPPORTED_MANIFEST");
  }

  const binaryBytes = new Uint8Array(await binaryFile.arrayBuffer());
  const jsonlBytes = new Uint8Array(await jsonlFile.arrayBuffer());

  if (sha256HexBytes(binaryBytes) !== manifest.members.binaryStream.sha256) {
    throw new Error("ERR_ARCHIVE_HASH_MISMATCH:frames.sdup.bin");
  }
  if (sha256HexBytes(jsonlBytes) !== manifest.members.jsonlIndex.sha256) {
    throw new Error("ERR_ARCHIVE_HASH_MISMATCH:frames.jsonl");
  }

  const records = unpackUdpBinaryStream(binaryBytes);
  if (records.length !== manifest.frameCount) {
    throw new Error(
      `ERR_ARCHIVE_COUNT_MISMATCH: manifest=${manifest.frameCount} actual=${records.length}`,
    );
  }

  return {
    manifest,
    records,
    sha256: sha256HexBytes(bytes),
    compressedBytes: bytes.byteLength,
  };
}

export interface UdpArchiveRecorderOptions {
  readonly maxBufferedFrames?: number;
  readonly maxBufferedBytes?: number;
  readonly nowMs?: () => number;
}

export interface UdpArchiveRecorder {
  recordDelivery(delivery: UdpTelemetryDelivery): boolean;
  recordFrame(
    frame: Omit<UdpTelemetryFrame, "crc32">,
    peer?: {
      readonly address?: string;
      readonly port?: number;
      readonly ipv6?: boolean;
    },
  ): boolean;
  readonly bufferedFrames: number;
  readonly bufferedBytes: number;
  readonly droppedOverCap: number;
  flushToBlob(
    receiverStats?: UdpTelemetryReceiverStats,
  ): Promise<BuiltUdpArchiveBlob>;
  flushToBlobStore(
    store: Pick<BlobStore, "put">,
    key: string,
    receiverStats?: UdpTelemetryReceiverStats,
  ): Promise<{
    readonly key: string;
    readonly bytesWritten: number;
    readonly archive: BuiltUdpArchiveBlob;
  }>;
  readonly [INSPECT_CUSTOM]: (depth: number) => unknown;
}

/**
 * Bounded in-memory binary UDP frame recorder that flushes directly to a compressed
 * `Bun.Archive` Blob or any `BlobStore` (R2 / `MemoryBlobStore`).
 */
export function createUdpArchiveRecorder(
  options: UdpArchiveRecorderOptions = {},
): UdpArchiveRecorder {
  const maxBufferedFrames = Math.max(1, options.maxBufferedFrames ?? 10_000);
  const maxBufferedBytes = Math.max(
    1_024,
    options.maxBufferedBytes ?? 8 * 1024 * 1024,
  );
  const nowMs = options.nowMs ?? (() => Date.now());

  const buffer: UdpCapturedRecordInput[] = [];
  let bufferedBytes = 0;
  let droppedOverCap = 0;

  const pushRecord = (record: UdpCapturedRecordInput): boolean => {
    if (
      buffer.length >= maxBufferedFrames ||
      bufferedBytes + record.rawFrame.byteLength > maxBufferedBytes
    ) {
      droppedOverCap += 1;
      return false;
    }
    buffer.push(record);
    bufferedBytes += record.rawFrame.byteLength;
    return true;
  };

  const flushToBlob = async (
    receiverStats?: UdpTelemetryReceiverStats,
  ): Promise<BuiltUdpArchiveBlob> => {
    const batch = buffer.splice(0, buffer.length);
    bufferedBytes = 0;
    return buildUdpArchiveBlob(batch, {
      publishedAtMs: nowMs(),
      ...(receiverStats === undefined ? {} : { receiverStats }),
    });
  };

  return {
    recordDelivery(delivery) {
      return pushRecord({
        receivedAtMs: nowMs(),
        address: delivery.address,
        port: delivery.port,
        ipv6: delivery.ipv6,
        rawFrame: delivery.rawBytes.slice(),
      });
    },
    recordFrame(frame, peer) {
      const encoded = encodeUdpTelemetryFrame({
        kind: frame.kind,
        seq: frame.seq,
        timestampMs: frame.timestampMs,
        flags: frame.flags,
        payload: frame.payload,
      });
      return pushRecord({
        receivedAtMs: nowMs(),
        address: peer?.address ?? "127.0.0.1",
        port: peer?.port ?? 0,
        ipv6: peer?.ipv6 ?? false,
        rawFrame: encoded,
      });
    },
    get bufferedFrames() {
      return buffer.length;
    },
    get bufferedBytes() {
      return bufferedBytes;
    },
    get droppedOverCap() {
      return droppedOverCap;
    },
    flushToBlob,
    async flushToBlobStore(store, key, receiverStats) {
      const archive = await flushToBlob(receiverStats);
      const { bytesWritten } = await store.put(
        key,
        archive.bytes,
        UDP_ARCHIVE_CONTENT_TYPE,
      );
      return { key, bytesWritten, archive };
    },
    [INSPECT_CUSTOM](depth: number) {
      const compact = `UdpArchiveRecorder(frames=${buffer.length} bytes=${bufferedBytes} dropped=${droppedOverCap})`;
      if (depth <= 0) return compact;
      return {
        bufferedFrames: buffer.length,
        bufferedBytes,
        droppedOverCap,
        maxBufferedFrames,
        maxBufferedBytes,
      };
    },
  };
}
