/**
 * @file src/lib/udp_telemetry.ts
 * @description Production Bun 1.4.5 UDP datagram telemetry codec and transports:
 * - 24-byte big-endian header + UTF-8 payload + 4-byte `Bun.hash.crc32` trailer (SIMD single-pass)
 * - Fail-closed `MSG_TRUNC` (`flags.truncated`), magic/version/length, and CRC32 validation
 * - Per-peer sequence gap, duplicate, and out-of-order tracking (bounded peer table)
 * - Connected batched publisher (`sendMany` + `drain` backpressure) and unconnected multi-peer fan-out publisher
 * - Receiver with IPv6 `ReceiveFlags`, multicast membership helpers, and `reloadOnFrame` hot-swap
 */

import type { udp } from "bun";

import {
  type BinaryPayload,
  decodeBinaryFrameText,
  toDataView,
  toUint8ArrayView,
} from "./binary_type.ts";

/** ASCII "SDUP" magic header (`0x53445550`). */
export const UDP_TELEMETRY_MAGIC = 0x53445550;
export const UDP_TELEMETRY_VERSION = 1;
export const UDP_TELEMETRY_HEADER_BYTES = 24;
export const UDP_TELEMETRY_CRC_BYTES = 4;
export const UDP_TELEMETRY_OVERHEAD_BYTES =
  UDP_TELEMETRY_HEADER_BYTES + UDP_TELEMETRY_CRC_BYTES;
/** Conservative IPv4/IPv6 safe MTU payload ceiling to avoid kernel IP fragmentation. */
export const MAX_UDP_DATAGRAM_BYTES = 1_400;

export const UDP_TELEMETRY_KINDS = [
  "tick",
  "volume_ping",
  "heartbeat",
  "alert",
] as const;

export type UdpTelemetryKind = (typeof UDP_TELEMETRY_KINDS)[number];

const KIND_TO_CODE: Readonly<Record<UdpTelemetryKind, number>> = {
  tick: 1,
  volume_ping: 2,
  heartbeat: 3,
  alert: 4,
};

const CODE_TO_KIND: Readonly<Record<number, UdpTelemetryKind>> = {
  1: "tick",
  2: "volume_ping",
  3: "heartbeat",
  4: "alert",
};

const UTF8_ENCODER = new TextEncoder();
const INSPECT_CUSTOM = Bun.inspect.custom;
const REPLAY_WINDOW_BITS = 64;
const REPLAY_WINDOW_MASK = (1n << 64n) - 1n;

export interface UdpTelemetryFrame {
  readonly kind: UdpTelemetryKind;
  readonly seq: number;
  readonly timestampMs: number;
  readonly flags: number;
  readonly payload: string;
  readonly crc32: number;
}

export interface UdpTelemetryFrameInput {
  readonly kind: UdpTelemetryKind;
  readonly seq: number;
  readonly timestampMs?: number;
  readonly flags?: number;
  readonly payload: string;
}

export type UdpDecodeErrorReason =
  | "truncated"
  | "too_short"
  | "bad_magic"
  | "unsupported_version"
  | "bad_kind"
  | "length_mismatch"
  | "bad_crc";

export type UdpDecodeResult =
  | { readonly ok: true; readonly frame: UdpTelemetryFrame }
  | { readonly ok: false; readonly reason: UdpDecodeErrorReason };

/**
 * Encodes a telemetry event into a 24-byte big-endian header + UTF-8 payload + 4-byte `Bun.hash.crc32` trailer.
 * Fails closed if the encoded datagram exceeds `maxDatagramBytes` (default 1400 B).
 */
export function encodeUdpTelemetryFrame(
  input: UdpTelemetryFrameInput,
  maxDatagramBytes = MAX_UDP_DATAGRAM_BYTES,
): Uint8Array<ArrayBuffer> {
  const payloadBytes = UTF8_ENCODER.encode(input.payload);
  const bodyEnd = UDP_TELEMETRY_HEADER_BYTES + payloadBytes.byteLength;
  const totalBytes = bodyEnd + UDP_TELEMETRY_CRC_BYTES;
  if (totalBytes > maxDatagramBytes) {
    throw new RangeError(
      `ERR_UDP_FRAME_TOO_LARGE: ${totalBytes}B exceeds max ${maxDatagramBytes}B`,
    );
  }

  const out = new Uint8Array(new ArrayBuffer(totalBytes));
  const view = new DataView(out.buffer);
  const tsMs = Math.max(0, Math.trunc(input.timestampMs ?? Date.now()));
  const seq = input.seq >>> 0;
  const flags = (input.flags ?? 0) & 0xffff;

  view.setUint32(0, UDP_TELEMETRY_MAGIC, false);
  view.setUint8(4, UDP_TELEMETRY_VERSION);
  view.setUint8(5, KIND_TO_CODE[input.kind]);
  view.setUint16(6, flags, false);
  view.setUint32(8, seq, false);
  view.setBigUint64(12, BigInt(tsMs), false);
  view.setUint32(20, payloadBytes.byteLength, false);
  out.set(payloadBytes, UDP_TELEMETRY_HEADER_BYTES);

  // Hardware-accelerated single-pass CRC32 over contiguous [header + payload].
  const crc = Bun.hash.crc32(out.subarray(0, bodyEnd)) >>> 0;
  view.setUint32(bodyEnd, crc, false);
  return out;
}

/**
 * Zero-allocation variant of `encodeUdpTelemetryFrame` that encodes directly into a caller-owned
 * scratch buffer using `TextEncoder.encodeInto` and returns a `subarray(0, totalBytes)` view.
 */
export function encodeUdpTelemetryFrameInto(
  target: Uint8Array,
  input: UdpTelemetryFrameInput,
  maxDatagramBytes = MAX_UDP_DATAGRAM_BYTES,
): Uint8Array {
  const cap = Math.min(target.byteLength, maxDatagramBytes);
  const maxPayloadBytes = cap - UDP_TELEMETRY_OVERHEAD_BYTES;
  if (maxPayloadBytes < 0) {
    throw new RangeError(
      `ERR_UDP_BUFFER_TOO_SMALL: target ${target.byteLength}B < overhead ${UDP_TELEMETRY_OVERHEAD_BYTES}B`,
    );
  }

  const payloadRegion = target.subarray(
    UDP_TELEMETRY_HEADER_BYTES,
    UDP_TELEMETRY_HEADER_BYTES + maxPayloadBytes,
  );
  const { read, written } = UTF8_ENCODER.encodeInto(
    input.payload,
    payloadRegion,
  );
  if (read < input.payload.length) {
    throw new RangeError(
      `ERR_UDP_FRAME_TOO_LARGE: payload exceeded max ${maxPayloadBytes}B in scratch buffer`,
    );
  }

  const bodyEnd = UDP_TELEMETRY_HEADER_BYTES + written;
  const totalBytes = bodyEnd + UDP_TELEMETRY_CRC_BYTES;
  const view = new DataView(target.buffer, target.byteOffset, totalBytes);
  const tsMs = Math.max(0, Math.trunc(input.timestampMs ?? Date.now()));
  const seq = input.seq >>> 0;
  const flags = (input.flags ?? 0) & 0xffff;

  view.setUint32(0, UDP_TELEMETRY_MAGIC, false);
  view.setUint8(4, UDP_TELEMETRY_VERSION);
  view.setUint8(5, KIND_TO_CODE[input.kind]);
  view.setUint16(6, flags, false);
  view.setUint32(8, seq, false);
  view.setBigUint64(12, BigInt(tsMs), false);
  view.setUint32(20, written, false);

  const crc = Bun.hash.crc32(target.subarray(0, bodyEnd)) >>> 0;
  view.setUint32(bodyEnd, crc, false);
  return target.subarray(0, totalBytes);
}

/**
 * Decodes and CRC32-verifies a binary UDP telemetry datagram via zero-copy `DataView`.
 * Checks `flags.truncated` (`MSG_TRUNC`) fail-closed before reading any header bytes.
 */
export function decodeUdpTelemetryFrame(
  raw: BinaryPayload | ArrayBufferView,
  receiveFlags?: Pick<udp.ReceiveFlags, "truncated">,
): UdpDecodeResult {
  if (receiveFlags?.truncated) {
    return { ok: false, reason: "truncated" };
  }
  const bytes = toUint8ArrayView(raw);
  if (bytes.byteLength < UDP_TELEMETRY_OVERHEAD_BYTES) {
    return { ok: false, reason: "too_short" };
  }
  const view = toDataView(bytes);
  if (view.getUint32(0, false) !== UDP_TELEMETRY_MAGIC) {
    return { ok: false, reason: "bad_magic" };
  }
  if (view.getUint8(4) !== UDP_TELEMETRY_VERSION) {
    return { ok: false, reason: "unsupported_version" };
  }
  const kind = CODE_TO_KIND[view.getUint8(5)];
  if (kind === undefined) {
    return { ok: false, reason: "bad_kind" };
  }
  const flags = view.getUint16(6, false);
  const seq = view.getUint32(8, false);
  const timestampMs = Number(view.getBigUint64(12, false));
  const payloadLen = view.getUint32(20, false);
  const bodyEnd = UDP_TELEMETRY_HEADER_BYTES + payloadLen;
  if (bodyEnd + UDP_TELEMETRY_CRC_BYTES !== bytes.byteLength) {
    return { ok: false, reason: "length_mismatch" };
  }
  const expectedCrc = view.getUint32(bodyEnd, false);
  const computedCrc = Bun.hash.crc32(bytes.subarray(0, bodyEnd)) >>> 0;
  if (computedCrc !== expectedCrc) {
    return { ok: false, reason: "bad_crc" };
  }

  const payloadSlice = bytes.subarray(UDP_TELEMETRY_HEADER_BYTES, bodyEnd);
  return {
    ok: true,
    frame: {
      kind,
      seq,
      timestampMs,
      flags,
      payload: decodeBinaryFrameText(payloadSlice),
      crc32: expectedCrc,
    },
  };
}

export type UdpSequenceStatus =
  "in_order" | "gap" | "duplicate" | "out_of_order";

export interface UdpSequenceObservation {
  readonly status: UdpSequenceStatus;
  readonly gap: number;
}

interface PeerSeqState {
  highestSeq: number;
  /** 64-bit sliding bitmap where bit `k` marks receipt of `(highestSeq - k) >>> 0`. */
  windowMask: bigint;
}

/**
 * Bounded per-peer sequence tracker with RFC 1982 `u32` wrap-safe modular arithmetic and a
 * 64-packet sliding replay bitmap distinguishing true late duplicates from out-of-order recovery.
 */
export class UdpPeerSequenceTracker {
  private readonly peers = new Map<string, PeerSeqState>();
  private readonly maxPeers: number;

  constructor(maxPeers = 256) {
    this.maxPeers = Math.max(1, maxPeers);
  }

  observe(peerKey: string, rawSeq: number): UdpSequenceObservation {
    const seq = rawSeq >>> 0;
    const existing = this.peers.get(peerKey);
    if (existing === undefined) {
      if (this.peers.size >= this.maxPeers) {
        const oldestKey = this.peers.keys().next().value;
        if (oldestKey !== undefined) this.peers.delete(oldestKey);
      }
      this.peers.set(peerKey, { highestSeq: seq, windowMask: 1n });
      return { status: "in_order", gap: 0 };
    }

    // Refresh insertion order for LRU eviction.
    this.peers.delete(peerKey);
    this.peers.set(peerKey, existing);

    // Signed 32-bit modular diff handles 0xffff_ffff -> 0 wrap-around cleanly.
    const diff = (seq - existing.highestSeq) | 0;
    if (diff === 0) {
      return { status: "duplicate", gap: 0 };
    }
    if (diff > 0) {
      existing.highestSeq = seq;
      existing.windowMask =
        diff >= REPLAY_WINDOW_BITS
          ? 1n
          : ((existing.windowMask << BigInt(diff)) | 1n) & REPLAY_WINDOW_MASK;
      if (diff === 1) {
        return { status: "in_order", gap: 0 };
      }
      return { status: "gap", gap: diff - 1 };
    }

    const back = -diff;
    if (back < REPLAY_WINDOW_BITS) {
      const bit = 1n << BigInt(back);
      if ((existing.windowMask & bit) !== 0n) {
        return { status: "duplicate", gap: 0 };
      }
      existing.windowMask |= bit;
    }
    return { status: "out_of_order", gap: 0 };
  }

  get peerCount(): number {
    return this.peers.size;
  }

  clear(): void {
    this.peers.clear();
  }
}

export interface UdpTelemetryPublisherOptions {
  readonly targetHost: string;
  readonly targetPort: number;
  readonly bindHost?: string;
  readonly bindPort?: number;
  readonly batchSize?: number;
  readonly maxQueueSize?: number;
  readonly ttl?: number;
  readonly broadcast?: boolean;
  readonly onError?: (error: Error) => void;
}

export interface UdpTelemetryPublisherStats {
  readonly sentPackets: number;
  readonly queuedPackets: number;
  readonly droppedOverCap: number;
  readonly backpressureEvents: number;
  readonly drainEvents: number;
  readonly errorCount: number;
  readonly lastError: string | null;
}

export interface UdpTelemetryPublisher extends Disposable {
  readonly socket: udp.ConnectedSocket<"uint8array">;
  enqueue(
    input: Omit<UdpTelemetryFrameInput, "seq"> & { seq?: number },
  ): boolean;
  enqueueRaw(datagram: Uint8Array<ArrayBuffer>): boolean;
  flush(): number;
  getStats(): UdpTelemetryPublisherStats;
  close(): void;
  readonly [INSPECT_CUSTOM]: (depth: number) => unknown;
}

/**
 * Connected UDP telemetry publisher using `Bun.udpSocket({ connect, binaryType: "uint8array" })`,
 * `sendMany()` syscall batching, bounded FIFO queueing, and kernel `drain()` backpressure resumption.
 */
export async function createUdpTelemetryPublisher(
  options: UdpTelemetryPublisherOptions,
): Promise<UdpTelemetryPublisher> {
  const batchSize = Math.max(1, options.batchSize ?? 32);
  const maxQueueSize = Math.max(1, options.maxQueueSize ?? 1_024);
  const queue: Uint8Array<ArrayBuffer>[] = [];

  let nextSeq = 1;
  let sentPackets = 0;
  let droppedOverCap = 0;
  let backpressureEvents = 0;
  let drainEvents = 0;
  let errorCount = 0;
  let lastError: string | null = null;
  let closed = false;

  const flushQueue = (sock: udp.ConnectedSocket<"uint8array">): number => {
    if (closed || queue.length === 0) return 0;
    let totalSent = 0;
    while (queue.length > 0) {
      const batch = queue.slice(0, batchSize);
      const sent = sock.sendMany(batch);
      if (sent > 0) {
        queue.splice(0, sent);
        sentPackets += sent;
        totalSent += sent;
      }
      if (sent < batch.length) {
        backpressureEvents += 1;
        break;
      }
    }
    return totalSent;
  };

  // Pass a fresh non-spread literal so TS rejects the unconnected SocketOptions overload
  // and selects Bun.udpSocket's ConnectedSocket<"uint8array"> overload cleanly.
  const socket = await Bun.udpSocket({
    hostname: options.bindHost ?? "127.0.0.1",
    port: options.bindPort ?? 0,
    binaryType: "uint8array",
    connect: {
      hostname: options.targetHost,
      port: options.targetPort,
    },
    socket: {
      drain(sock: udp.ConnectedSocket<"uint8array">) {
        drainEvents += 1;
        flushQueue(sock);
      },
      error(_sock, err) {
        errorCount += 1;
        lastError = err.message;
        options.onError?.(err);
      },
    },
  });

  if (options.ttl !== undefined) {
    socket.setTTL(options.ttl);
  }
  if (options.broadcast !== undefined) {
    socket.setBroadcast(options.broadcast);
  }

  const enqueueRaw = (datagram: Uint8Array<ArrayBuffer>): boolean => {
    if (closed) return false;
    if (queue.length >= maxQueueSize) {
      droppedOverCap += 1;
      return false;
    }
    queue.push(datagram);
    if (queue.length >= batchSize) {
      flushQueue(socket);
    }
    return true;
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    queue.length = 0;
    socket.close();
  };

  return {
    socket,
    enqueue(input) {
      const seq = input.seq ?? nextSeq++;
      const encoded = encodeUdpTelemetryFrame({
        kind: input.kind,
        seq,
        payload: input.payload,
        ...(input.timestampMs === undefined
          ? {}
          : { timestampMs: input.timestampMs }),
        ...(input.flags === undefined ? {} : { flags: input.flags }),
      });
      return enqueueRaw(encoded);
    },
    enqueueRaw,
    flush() {
      return flushQueue(socket);
    },
    getStats() {
      return {
        sentPackets,
        queuedPackets: queue.length,
        droppedOverCap,
        backpressureEvents,
        drainEvents,
        errorCount,
        lastError,
      };
    },
    close,
    [Symbol.dispose]() {
      close();
    },
    [INSPECT_CUSTOM](depth: number) {
      const compact = `UdpTelemetryPublisher(${options.targetHost}:${options.targetPort} sent=${sentPackets} queued=${queue.length} dropped=${droppedOverCap})`;
      if (depth <= 0) return compact;
      return {
        target: `${options.targetHost}:${options.targetPort}`,
        binaryType: socket.binaryType,
        closed,
        sentPackets,
        queuedPackets: queue.length,
        droppedOverCap,
        backpressureEvents,
        drainEvents,
        errorCount,
      };
    },
  };
}

export interface UdpPeerEndpoint {
  readonly address: string;
  readonly port: number;
}

export interface UdpTelemetryFanoutOptions {
  readonly bindHost?: string;
  readonly bindPort?: number;
  readonly peers?: readonly UdpPeerEndpoint[];
  readonly maxQueueSize?: number;
  readonly multicastTTL?: number;
  readonly multicastLoopback?: boolean;
  readonly multicastInterface?: string;
  readonly onError?: (error: Error) => void;
}

export interface UdpTelemetryFanoutPublisher extends Disposable {
  readonly socket: udp.Socket<"uint8array">;
  addPeer(peer: UdpPeerEndpoint): void;
  removePeer(peer: UdpPeerEndpoint): boolean;
  broadcastFrame(
    input: Omit<UdpTelemetryFrameInput, "seq"> & { seq?: number },
  ): number;
  sendTo(
    peer: UdpPeerEndpoint,
    input: Omit<UdpTelemetryFrameInput, "seq"> & { seq?: number },
  ): boolean;
  flush(): number;
  getStats(): UdpTelemetryPublisherStats;
  close(): void;
  readonly [INSPECT_CUSTOM]: (depth: number) => unknown;
}

/**
 * Unconnected multi-peer fan-out publisher using `sendMany([data, port, ip, ...])` so one encoded
 * datagram fans out to N peers (or multicast groups) in a single batched syscall.
 */
export async function createUdpTelemetryFanoutPublisher(
  options: UdpTelemetryFanoutOptions = {},
): Promise<UdpTelemetryFanoutPublisher> {
  const maxQueueSize = Math.max(1, options.maxQueueSize ?? 1_024);
  const peers = new Map<string, UdpPeerEndpoint>();
  for (const p of options.peers ?? []) {
    peers.set(`${p.address}:${p.port}`, p);
  }
  const pending: Array<{
    readonly datagram: Uint8Array<ArrayBuffer>;
    readonly port: number;
    readonly address: string;
  }> = [];

  let nextSeq = 1;
  let sentPackets = 0;
  let droppedOverCap = 0;
  let backpressureEvents = 0;
  let drainEvents = 0;
  let errorCount = 0;
  let lastError: string | null = null;
  let closed = false;

  const flushPending = (sock: udp.Socket<"uint8array">): number => {
    if (closed || pending.length === 0) return 0;
    const flat: Array<Uint8Array<ArrayBuffer> | number | string> = [];
    for (const item of pending) {
      flat.push(item.datagram, item.port, item.address);
    }
    const sent = sock.sendMany(flat);
    if (sent > 0) {
      pending.splice(0, sent);
      sentPackets += sent;
    }
    if (pending.length > 0) {
      backpressureEvents += 1;
    }
    return sent;
  };

  const socket = await Bun.udpSocket({
    hostname: options.bindHost ?? "127.0.0.1",
    port: options.bindPort ?? 0,
    binaryType: "uint8array",
    socket: {
      drain(sock) {
        drainEvents += 1;
        flushPending(sock);
      },
      error(_sock, err) {
        errorCount += 1;
        lastError = err.message;
        options.onError?.(err);
      },
    },
  });

  if (options.multicastTTL !== undefined) {
    socket.setMulticastTTL(options.multicastTTL);
  }
  if (options.multicastLoopback !== undefined) {
    socket.setMulticastLoopback(options.multicastLoopback);
  }
  if (options.multicastInterface !== undefined) {
    socket.setMulticastInterface(options.multicastInterface);
  }

  const close = (): void => {
    if (closed) return;
    closed = true;
    pending.length = 0;
    socket.close();
  };

  return {
    socket,
    addPeer(peer) {
      peers.set(`${peer.address}:${peer.port}`, peer);
    },
    removePeer(peer) {
      return peers.delete(`${peer.address}:${peer.port}`);
    },
    broadcastFrame(input) {
      if (closed || peers.size === 0) return 0;
      const seq = input.seq ?? nextSeq++;
      const encoded = encodeUdpTelemetryFrame({
        kind: input.kind,
        seq,
        payload: input.payload,
        ...(input.timestampMs === undefined
          ? {}
          : { timestampMs: input.timestampMs }),
        ...(input.flags === undefined ? {} : { flags: input.flags }),
      });
      for (const peer of peers.values()) {
        if (pending.length >= maxQueueSize) {
          droppedOverCap += 1;
          continue;
        }
        pending.push({
          datagram: encoded,
          port: peer.port,
          address: peer.address,
        });
      }
      return flushPending(socket);
    },
    sendTo(peer, input) {
      if (closed) return false;
      const seq = input.seq ?? nextSeq++;
      const encoded = encodeUdpTelemetryFrame({
        kind: input.kind,
        seq,
        payload: input.payload,
        ...(input.timestampMs === undefined
          ? {}
          : { timestampMs: input.timestampMs }),
        ...(input.flags === undefined ? {} : { flags: input.flags }),
      });
      if (pending.length >= maxQueueSize) {
        droppedOverCap += 1;
        return false;
      }
      pending.push({
        datagram: encoded,
        port: peer.port,
        address: peer.address,
      });
      return flushPending(socket) > 0;
    },
    flush() {
      return flushPending(socket);
    },
    getStats() {
      return {
        sentPackets,
        queuedPackets: pending.length,
        droppedOverCap,
        backpressureEvents,
        drainEvents,
        errorCount,
        lastError,
      };
    },
    close,
    [Symbol.dispose]() {
      close();
    },
    [INSPECT_CUSTOM](depth: number) {
      const compact = `UdpTelemetryFanoutPublisher(peers=${peers.size} sent=${sentPackets} queued=${pending.length} dropped=${droppedOverCap})`;
      if (depth <= 0) return compact;
      return {
        bind: `${socket.hostname}:${socket.port}`,
        binaryType: socket.binaryType,
        peerCount: peers.size,
        closed,
        sentPackets,
        queuedPackets: pending.length,
        droppedOverCap,
        backpressureEvents,
        drainEvents,
        errorCount,
      };
    },
  };
}

export interface UdpTelemetryDelivery {
  readonly frame: UdpTelemetryFrame;
  readonly rawBytes: Uint8Array<ArrayBuffer>;
  readonly port: number;
  readonly address: string;
  readonly ipv6: boolean;
  readonly byteLength: number;
  readonly seqStatus: UdpSequenceStatus;
  readonly seqGap: number;
}

export interface UdpMulticastMembership {
  readonly group: string;
  readonly interfaceAddress?: string;
}

export interface UdpTelemetryReceiverOptions {
  readonly hostname?: string;
  readonly port?: number;
  readonly maxTrackedPeers?: number;
  readonly multicastGroups?: readonly UdpMulticastMembership[];
  readonly onFrame: (delivery: UdpTelemetryDelivery) => void;
  readonly onDrop?: (
    reason: UdpDecodeErrorReason,
    meta: {
      readonly port: number;
      readonly address: string;
      readonly ipv6: boolean;
    },
  ) => void;
  readonly onError?: (error: Error) => void;
}

export interface UdpTelemetryReceiverStats {
  readonly receivedPackets: number;
  readonly decodedFrames: number;
  readonly truncatedPackets: number;
  readonly malformedPackets: number;
  readonly crcFailures: number;
  readonly sequenceGaps: number;
  readonly missingPackets: number;
  readonly duplicatePackets: number;
  readonly outOfOrderPackets: number;
  readonly trackedPeers: number;
  readonly ipv6Packets: number;
  readonly errorCount: number;
  readonly lastError: string | null;
}

export interface UdpTelemetryReceiver extends Disposable {
  readonly socket: udp.Socket<"uint8array">;
  readonly port: number;
  readonly address: string;
  joinMulticast(group: string, interfaceAddress?: string): boolean;
  leaveMulticast(group: string, interfaceAddress?: string): boolean;
  reloadOnFrame(onFrame: (delivery: UdpTelemetryDelivery) => void): void;
  getStats(): UdpTelemetryReceiverStats;
  close(): void;
  readonly [INSPECT_CUSTOM]: (depth: number) => unknown;
}

/**
 * UDP telemetry receiver pinned to `binaryType: "uint8array"` with `MSG_TRUNC` (`flags.truncated`),
 * `Bun.hash.crc32` integrity verification, per-peer sequence-gap/reorder accounting, multicast helpers,
 * and live `reloadOnFrame()` hot-swap.
 */
export async function createUdpTelemetryReceiver(
  options: UdpTelemetryReceiverOptions,
): Promise<UdpTelemetryReceiver> {
  const seqTracker = new UdpPeerSequenceTracker(options.maxTrackedPeers ?? 256);

  let receivedPackets = 0;
  let decodedFrames = 0;
  let truncatedPackets = 0;
  let malformedPackets = 0;
  let crcFailures = 0;
  let sequenceGaps = 0;
  let missingPackets = 0;
  let duplicatePackets = 0;
  let outOfOrderPackets = 0;
  let ipv6Packets = 0;
  let errorCount = 0;
  let lastError: string | null = null;
  let closed = false;

  const makeHandler = (
    onFrame: (delivery: UdpTelemetryDelivery) => void,
  ): udp.SocketHandler<"uint8array"> => ({
    data(_sock, data, port, address, flags) {
      receivedPackets += 1;
      if (flags.ipv6) ipv6Packets += 1;
      const decoded = decodeUdpTelemetryFrame(data, flags);
      if (!decoded.ok) {
        if (decoded.reason === "truncated") {
          truncatedPackets += 1;
        } else if (decoded.reason === "bad_crc") {
          crcFailures += 1;
        } else {
          malformedPackets += 1;
        }
        options.onDrop?.(decoded.reason, {
          port,
          address,
          ipv6: flags.ipv6,
        });
        return;
      }
      decodedFrames += 1;
      const peerKey = flags.ipv6
        ? `[${address}]:${port}`
        : `${address}:${port}`;
      const obs = seqTracker.observe(peerKey, decoded.frame.seq);
      if (obs.status === "gap") {
        sequenceGaps += 1;
        missingPackets += obs.gap;
      } else if (obs.status === "duplicate") {
        duplicatePackets += 1;
      } else if (obs.status === "out_of_order") {
        outOfOrderPackets += 1;
      }
      onFrame({
        frame: decoded.frame,
        rawBytes: data,
        port,
        address,
        ipv6: flags.ipv6,
        byteLength: data.byteLength,
        seqStatus: obs.status,
        seqGap: obs.gap,
      });
    },
    error(_sock, err) {
      errorCount += 1;
      lastError = err.message;
      options.onError?.(err);
    },
  });

  const socket = await Bun.udpSocket({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 0,
    binaryType: "uint8array",
    socket: makeHandler(options.onFrame),
  });

  for (const membership of options.multicastGroups ?? []) {
    socket.addMembership(membership.group, membership.interfaceAddress);
  }

  const close = (): void => {
    if (closed) return;
    closed = true;
    socket.close();
  };

  return {
    socket,
    port: socket.port,
    address: socket.hostname,
    joinMulticast(group, interfaceAddress) {
      return socket.addMembership(group, interfaceAddress);
    },
    leaveMulticast(group, interfaceAddress) {
      return socket.dropMembership(group, interfaceAddress);
    },
    reloadOnFrame(onFrame) {
      if (closed) return;
      // Bun 1.4.5 quirk: bun-types declares `reload(handler)`, but the runtime ignores direct
      // `{ data }` and requires the nested `{ socket: handler }` shape (same as TCP reload).
      socket.reload({
        socket: makeHandler(onFrame),
      } as unknown as udp.SocketHandler<"uint8array">);
    },
    getStats() {
      return {
        receivedPackets,
        decodedFrames,
        truncatedPackets,
        malformedPackets,
        crcFailures,
        sequenceGaps,
        missingPackets,
        duplicatePackets,
        outOfOrderPackets,
        trackedPeers: seqTracker.peerCount,
        ipv6Packets,
        errorCount,
        lastError,
      };
    },
    close,
    [Symbol.dispose]() {
      close();
    },
    [INSPECT_CUSTOM](depth: number) {
      const compact = `UdpTelemetryReceiver(${socket.hostname}:${socket.port} decoded=${decodedFrames} gaps=${sequenceGaps} crcFail=${crcFailures})`;
      if (depth <= 0) return compact;
      return {
        bind: `${socket.hostname}:${socket.port}`,
        binaryType: socket.binaryType,
        closed,
        receivedPackets,
        decodedFrames,
        crcFailures,
        sequenceGaps,
        missingPackets,
        duplicatePackets,
        outOfOrderPackets,
        trackedPeers: seqTracker.peerCount,
        ipv6Packets,
      };
    },
  };
}
