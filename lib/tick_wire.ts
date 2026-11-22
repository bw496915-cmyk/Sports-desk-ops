/**
 * @file tick_wire.ts
 * @description One owner for the 24-byte tick frame, its fanout, and the wss client.
 *
 * `pause()` stops socket reads. It does not stop `server.publish`. Outbound stall is
 * `unsubscribe`. `ca` does not request a client certificate. `new WebSocket` does not
 * read `HTTPS_PROXY`, and its proxy schemes are `http:` and `https:`.
 */

import type { TLSOptions } from "bun";

export const TICK_TOPIC = "ticks";
export const TICK_FRAME_BYTES = 24;
export const TICK_HIGH_WATER_BYTES = 400 * TICK_FRAME_BYTES;
export const TICK_LOW_WATER_BYTES = 80 * TICK_FRAME_BYTES;
export const TICK_EVICT_WATER_BYTES = 1024 * TICK_FRAME_BYTES;
export const TICK_MAX_DROPPED = 500;
/** RFC 6455 policy violation. Browsers accept 1008. */
export const TICK_CLOSE_SLOW = 1008;

const FRAME_WORDS = TICK_FRAME_BYTES / 4;
const NS_PER_HI = 0x1_0000_0000;

export interface MonotonicClock {
  nowNs(): number;
}

const DEFAULT_CLOCK: MonotonicClock = {
  nowNs: () => Bun.nanoseconds(),
};

export interface TickClientData {
  id: number;
  stalled: boolean;
  dropped: number;
}

/**
 * Outbound fanout socket. `pause` is not on this type: it stops reads, and the
 * publish path must not grow a `Set` iterator.
 */
export interface TickFanoutSocket {
  readonly data: TickClientData;
  getBufferedAmount(): number;
  subscribe(topic: string): void;
  unsubscribe(topic: string): void;
  close(code: number, reason: string): void;
}

export interface TickClientTable {
  readonly slots: TickFanoutSocket[];
}

export function createTickClientTable(): TickClientTable {
  return { slots: [] };
}

export function addTickClient(
  table: TickClientTable,
  ws: TickFanoutSocket,
): void {
  table.slots.push(ws);
  ws.subscribe(TICK_TOPIC);
}

export function removeTickClient(
  table: TickClientTable,
  ws: TickFanoutSocket,
): void {
  const index = table.slots.indexOf(ws);
  if (index < 0) return;
  const last = table.slots.pop();
  if (last === undefined || last === ws) return;
  table.slots[index] = last;
}

/**
 * Drop or unsubscribe stalled peers before `server.publish`. Swap-remove keeps
 * the walk on integer indexes.
 */
export function stallTickClients(table: TickClientTable): void {
  let index = 0;
  while (index < table.slots.length) {
    const ws = table.slots[index];
    if (ws === undefined) {
      index += 1;
      continue;
    }
    const buffered = ws.getBufferedAmount();
    if (
      buffered >= TICK_EVICT_WATER_BYTES ||
      ws.data.dropped >= TICK_MAX_DROPPED
    ) {
      removeTickClient(table, ws);
      ws.close(TICK_CLOSE_SLOW, "ERR_WS_SLOW_SUBSCRIBER");
      continue;
    }
    if (!ws.data.stalled && buffered >= TICK_HIGH_WATER_BYTES) {
      ws.data.stalled = true;
      ws.unsubscribe(TICK_TOPIC);
    }
    if (ws.data.stalled) ws.data.dropped += 1;
    index += 1;
  }
}

/** Resubscribe once the socket buffer is back under the low watermark. */
export function releaseTickClient(ws: TickFanoutSocket): boolean {
  if (!ws.data.stalled) return false;
  if (ws.getBufferedAmount() > TICK_LOW_WATER_BYTES) return false;
  ws.data.stalled = false;
  ws.data.dropped = 0;
  ws.subscribe(TICK_TOPIC);
  return true;
}

/**
 * Power-of-two column store. One preallocated 24-byte frame is packed for every
 * publish. There is no read cursor: a stalled peer misses ticks, it does not
 * replay them.
 */
export class TickRingSoA {
  readonly mask: number;
  readonly eventId: Uint32Array;
  readonly priceCents: Int32Array;
  readonly lineHundredths: Int32Array;
  readonly monoNsLo: Uint32Array;
  readonly monoNsHi: Uint32Array;
  readonly seq: Uint32Array;
  head = 0;

  private readonly frameWords = new Uint32Array(FRAME_WORDS);
  private readonly frameBytes = new Uint8Array(this.frameWords.buffer);

  constructor(capacityPowerOfTwo = 1024) {
    if (
      (capacityPowerOfTwo & (capacityPowerOfTwo - 1)) !== 0 ||
      capacityPowerOfTwo < 2
    ) {
      throw new Error(
        `ERR_RING_CAP: capacity must be a power of two, got ${capacityPowerOfTwo}`,
      );
    }
    this.mask = capacityPowerOfTwo - 1;
    this.eventId = new Uint32Array(capacityPowerOfTwo);
    this.priceCents = new Int32Array(capacityPowerOfTwo);
    this.lineHundredths = new Int32Array(capacityPowerOfTwo);
    this.monoNsLo = new Uint32Array(capacityPowerOfTwo);
    this.monoNsHi = new Uint32Array(capacityPowerOfTwo);
    this.seq = new Uint32Array(capacityPowerOfTwo);
  }

  push(
    eventId: number,
    priceCents: number,
    lineHundredths: number,
    monoNs: number,
  ): number {
    const slot = this.head & this.mask;
    this.head += 1;
    this.eventId[slot] = eventId >>> 0;
    this.priceCents[slot] = priceCents | 0;
    this.lineHundredths[slot] = lineHundredths | 0;
    this.monoNsLo[slot] = monoNs >>> 0;
    this.monoNsHi[slot] = Math.floor(monoNs / NS_PER_HI) >>> 0;
    this.seq[slot] = this.head >>> 0;
    return slot;
  }

  /** View of the scratch frame. Valid until the next `packSlot`. */
  packSlot(slot: number): Uint8Array {
    const words = this.frameWords;
    words[0] = this.seq[slot] ?? 0;
    words[1] = this.eventId[slot] ?? 0;
    words[2] = (this.priceCents[slot] ?? 0) >>> 0;
    words[3] = (this.lineHundredths[slot] ?? 0) >>> 0;
    words[4] = this.monoNsLo[slot] ?? 0;
    words[5] = this.monoNsHi[slot] ?? 0;
    return this.frameBytes;
  }
}

/** One 24-byte buffer for the life of the client. Signed columns are `| 0`. */
export class TickFrameScratch {
  readonly bytes = new Uint8Array(TICK_FRAME_BYTES);
  readonly words = new Uint32Array(this.bytes.buffer);

  copyFrom(src: Uint8Array): boolean {
    if (src.byteLength !== TICK_FRAME_BYTES) return false;
    this.bytes.set(src);
    return true;
  }
}

export type TickPem = Exclude<
  NonNullable<TLSOptions["cert"]>,
  ReadonlyArray<unknown>
>;

type TickTlsFields = {
  cert: TickPem;
  key: TickPem;
  passphrase?: string;
};

/**
 * `ca?: never` is the discriminant. A union member that merely adds `ca`
 * still accepts `{ ca }` with no `requestCert`, because excess-property
 * checks only fire when no member has that key.
 */
export type TickServerTls =
  | (TickTlsFields & { ca?: never; requestCert?: never })
  | (TickTlsFields & {
      ca: TickPem;
      requestCert: true;
      rejectUnauthorized?: boolean;
    });

function toServeTls(tls: TickServerTls | undefined): TLSOptions | undefined {
  if (tls === undefined) return undefined;
  if (tls.requestCert === true) {
    return {
      cert: tls.cert,
      key: tls.key,
      ...(tls.passphrase === undefined ? {} : { passphrase: tls.passphrase }),
      ca: tls.ca,
      requestCert: true,
      ...(tls.rejectUnauthorized === undefined
        ? {}
        : { rejectUnauthorized: tls.rejectUnauthorized }),
    };
  }
  return {
    cert: tls.cert,
    key: tls.key,
    ...(tls.passphrase === undefined ? {} : { passphrase: tls.passphrase }),
  };
}

export function assertTickServerTls(tls: {
  cert: TickPem;
  key: TickPem;
  passphrase?: string;
  ca?: TickPem;
  requestCert?: boolean;
  rejectUnauthorized?: boolean;
}): TickServerTls {
  const base = {
    cert: tls.cert,
    key: tls.key,
    ...(tls.passphrase === undefined ? {} : { passphrase: tls.passphrase }),
  };
  if (tls.requestCert === true) {
    if (tls.ca === undefined) {
      throw new Error("ERR_TICK_MTLS: requestCert requires ca");
    }
    return {
      ...base,
      ca: tls.ca,
      requestCert: true,
      ...(tls.rejectUnauthorized === undefined
        ? {}
        : { rejectUnauthorized: tls.rejectUnauthorized }),
    };
  }
  if (tls.ca !== undefined) {
    throw new Error("ERR_TICK_MTLS: ca requires requestCert: true");
  }
  return base;
}

export type TickProxy =
  | string
  | URL
  | {
      url: string | URL;
      headers?: Record<string, string>;
      tls?: TLSOptions | boolean;
    };

function proxyUrl(proxy: TickProxy): URL {
  if (typeof proxy === "string") return new URL(proxy);
  if (proxy instanceof URL) return proxy;
  return typeof proxy.url === "string" ? new URL(proxy.url) : proxy.url;
}

/**
 * Accept only `http:` and `https:`. Does not read `HTTPS_PROXY` or `ALL_PROXY`.
 * `socks5:` is rejected here; `fetch` also ignores that scheme in `ALL_PROXY`.
 */
export function resolveTickProxy(proxy: TickProxy): TickProxy {
  const url = proxyUrl(proxy);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `ERR_TICK_PROXY_SCHEME: WebSocket proxy scheme ${url.protocol} is not http: or https:`,
    );
  }
  return proxy;
}

export interface TickClientConfig {
  url: string;
  proxy?: TickProxy;
  tls?: TLSOptions;
  headers?: Record<string, string>;
  onFrame: (
    seq: number,
    eventId: number,
    priceCents: number,
    lineHundredths: number,
    monoNsLo: number,
    monoNsHi: number,
  ) => void;
}

export function tickSocketOptions(cfg: TickClientConfig): {
  perMessageDeflate: false;
  headers?: Record<string, string>;
  tls?: TLSOptions;
  proxy?: TickProxy;
} {
  return {
    perMessageDeflate: false,
    ...(cfg.headers === undefined ? {} : { headers: cfg.headers }),
    ...(cfg.tls === undefined ? {} : { tls: cfg.tls }),
    ...(cfg.proxy === undefined ? {} : { proxy: resolveTickProxy(cfg.proxy) }),
  };
}

export function connectTickClient(cfg: TickClientConfig): WebSocket {
  const scratch = new TickFrameScratch();
  const ws = new WebSocket(cfg.url, tickSocketOptions(cfg));
  ws.binaryType = "nodebuffer";
  ws.onmessage = (event) => {
    const data: unknown = event.data;
    if (!(data instanceof Uint8Array)) return;
    if (!scratch.copyFrom(data)) return;
    const words = scratch.words;
    cfg.onFrame(
      words[0] ?? 0,
      words[1] ?? 0,
      (words[2] ?? 0) | 0,
      (words[3] ?? 0) | 0,
      words[4] ?? 0,
      words[5] ?? 0,
    );
  };
  return ws;
}

export interface TickServerHandle {
  server: Bun.Server<TickClientData>;
  ring: TickRingSoA;
  onTick: (eventId: number, priceCents: number, lineHundredths: number) => void;
}

export interface TickServerConfig {
  port: number;
  hostname?: string;
  clock?: MonotonicClock;
  tls?: TickServerTls;
}

export function startTickServer(config: TickServerConfig): TickServerHandle {
  const tls =
    config.tls === undefined ? undefined : assertTickServerTls(config.tls);
  const clock = config.clock ?? DEFAULT_CLOCK;
  const ring = new TickRingSoA(2048);
  const table = createTickClientTable();
  let nextClientId = 1;

  const hostname = config.hostname ?? "0.0.0.0";
  const serveTls = toServeTls(tls);
  const server = Bun.serve<TickClientData>({
    port: config.port,
    hostname,
    ...(serveTls === undefined ? {} : { tls: serveTls }),
    fetch(req, srv) {
      const upgraded = srv.upgrade(req, {
        data: { id: nextClientId, stalled: false, dropped: 0 },
      });
      if (!upgraded) return new Response("Upgrade required", { status: 426 });
      nextClientId += 1;
      return undefined;
    },
    websocket: {
      data: {} as TickClientData,
      perMessageDeflate: false,
      backpressureLimit: TICK_EVICT_WATER_BYTES,
      closeOnBackpressureLimit: true,
      maxPayloadLength: 1024,
      open(ws) {
        addTickClient(table, ws);
      },
      message() {},
      drain(ws) {
        releaseTickClient(ws);
      },
      close(ws) {
        removeTickClient(table, ws);
      },
    },
  });

  return {
    server,
    ring,
    onTick(eventId, priceCents, lineHundredths) {
      const slot = ring.push(
        eventId,
        priceCents,
        lineHundredths,
        clock.nowNs(),
      );
      const frame = ring.packSlot(slot);
      stallTickClients(table);
      server.publish(TICK_TOPIC, frame, false);
    },
  };
}
