import { afterEach, describe, expect, test } from "bun:test";

import {
  assertTickServerTls,
  createTickClientTable,
  releaseTickClient,
  resolveTickProxy,
  stallTickClients,
  startTickServer,
  TICK_CLOSE_SLOW,
  TICK_EVICT_WATER_BYTES,
  TICK_HIGH_WATER_BYTES,
  TICK_LOW_WATER_BYTES,
  TICK_MAX_DROPPED,
  TickFrameScratch,
  TickRingSoA,
  tickSocketOptions,
  connectTickClient,
  type TickFanoutSocket,
  type TickClientData,
} from "../lib/tick_wire.ts";

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function peer(
  buffered: number,
  data: TickClientData,
): {
  socket: TickFanoutSocket;
  unsubscribed: string[];
  subscribed: string[];
  closes: Array<{ code: number; reason: string }>;
} {
  const unsubscribed: string[] = [];
  const subscribed: string[] = [];
  const closes: Array<{ code: number; reason: string }> = [];
  const socket: TickFanoutSocket = {
    data,
    getBufferedAmount: () => buffered,
    subscribe(topic) {
      subscribed.push(topic);
    },
    unsubscribe(topic) {
      unsubscribed.push(topic);
    },
    close(code, reason) {
      closes.push({ code, reason });
    },
  };
  return { socket, unsubscribed, subscribed, closes };
}

describe("stallTickClients", () => {
  test("the fanout source does not call pause or allocate a Set", async () => {
    const source = await Bun.file(
      new URL("../lib/tick_wire.ts", import.meta.url),
    ).text();
    expect(source.includes(".pause(")).toBe(false);
    expect(source.includes("new Set")).toBe(false);
  });

  test("unsubscribes at the high watermark and does not pause", () => {
    const table = createTickClientTable();
    const slow = peer(TICK_HIGH_WATER_BYTES, {
      id: 1,
      stalled: false,
      dropped: 0,
    });
    const fine = peer(0, { id: 2, stalled: false, dropped: 0 });
    table.slots.push(slow.socket, fine.socket);

    stallTickClients(table);

    expect(slow.unsubscribed).toEqual(["ticks"]);
    expect(slow.socket.data.stalled).toBe(true);
    expect(slow.socket.data.dropped).toBe(1);
    expect(slow.closes).toEqual([]);
    expect(fine.unsubscribed).toEqual([]);
    expect(fine.socket.data.dropped).toBe(0);
    expect("pause" in slow.socket).toBe(false);
  });

  test("closes and swap-removes at the evict watermark", () => {
    const table = createTickClientTable();
    const doomed = peer(TICK_EVICT_WATER_BYTES, {
      id: 1,
      stalled: true,
      dropped: 1,
    });
    const keep = peer(0, { id: 2, stalled: false, dropped: 0 });
    table.slots.push(doomed.socket, keep.socket);

    stallTickClients(table);

    expect(doomed.closes).toEqual([
      { code: TICK_CLOSE_SLOW, reason: "ERR_WS_SLOW_SUBSCRIBER" },
    ]);
    expect(table.slots).toEqual([keep.socket]);
  });

  test("closes once dropped ticks reach the cap", () => {
    const table = createTickClientTable();
    const slow = peer(0, {
      id: 1,
      stalled: true,
      dropped: TICK_MAX_DROPPED,
    });
    table.slots.push(slow.socket);
    stallTickClients(table);
    expect(slow.closes).toEqual([
      { code: TICK_CLOSE_SLOW, reason: "ERR_WS_SLOW_SUBSCRIBER" },
    ]);
    expect(table.slots).toEqual([]);
  });

  test("release resubscribes only under the low watermark and clears dropped", () => {
    const held = peer(TICK_LOW_WATER_BYTES + 1, {
      id: 1,
      stalled: true,
      dropped: 4,
    });
    expect(releaseTickClient(held.socket)).toBe(false);
    expect(held.subscribed).toEqual([]);

    const ready = peer(TICK_LOW_WATER_BYTES, {
      id: 2,
      stalled: true,
      dropped: 4,
    });
    expect(releaseTickClient(ready.socket)).toBe(true);
    expect(ready.socket.data).toEqual({ id: 2, stalled: false, dropped: 0 });
    expect(ready.subscribed).toEqual(["ticks"]);
  });
});

describe("TickRingSoA", () => {
  test("packs a signed price into one reused 24-byte frame", () => {
    const ring = new TickRingSoA(8);
    const slot = ring.push(7, -150, 25, 0x1_0000_0005);
    const first = ring.packSlot(slot);
    const second = ring.packSlot(slot);
    expect(first).toBe(second);
    expect(first.byteLength).toBe(24);
    expect("tail" in ring).toBe(false);

    const scratch = new TickFrameScratch();
    expect(scratch.copyFrom(first)).toBe(true);
    const words = scratch.words;
    expect(words[0]).toBe(1);
    expect(words[1]).toBe(7);
    expect((words[2] ?? 0) | 0).toBe(-150);
    expect((words[3] ?? 0) | 0).toBe(25);
    expect(words[4]).toBe(5);
    expect(words[5]).toBe(1);
  });

  test("rejects a capacity that is not a power of two", () => {
    expect(() => new TickRingSoA(1000)).toThrow("ERR_RING_CAP");
  });
});

describe("tick TLS and proxy", () => {
  test("ca without requestCert throws ERR_TICK_MTLS", () => {
    expect(() =>
      assertTickServerTls({ cert: "cert", key: "key", ca: "ca" }),
    ).toThrow("ERR_TICK_MTLS: ca requires requestCert: true");
  });

  test("requestCert with ca is accepted", () => {
    const tls = assertTickServerTls({
      cert: "cert",
      key: "key",
      ca: "ca",
      requestCert: true,
    });
    expect(tls).toEqual({
      cert: "cert",
      key: "key",
      ca: "ca",
      requestCert: true,
    });
  });

  test("socks5 is rejected and proxy env vars are not read", async () => {
    expect(() => resolveTickProxy("socks5://127.0.0.1:1080")).toThrow(
      "ERR_TICK_PROXY_SCHEME",
    );
    const source = await Bun.file(
      new URL("../lib/tick_wire.ts", import.meta.url),
    ).text();
    expect(source.includes("Bun.env")).toBe(false);
    expect(source.includes("process.env")).toBe(false);
    const options = tickSocketOptions({
      url: "wss://feed.example/ticks",
      onFrame() {},
    });
    expect(options.proxy).toBeUndefined();
    expect(options.perMessageDeflate).toBe(false);
  });

  test("an https proxy object is passed through", () => {
    const proxy = {
      url: "https://proxy.internal:8443",
      headers: { "Proxy-Authorization": "Bearer token" },
      tls: { ca: "proxy-ca" },
    };
    expect(resolveTickProxy(proxy)).toBe(proxy);
  });
});

describe("startTickServer", () => {
  test("two publishes deliver two distinct little-endian frames", async () => {
    const handle = startTickServer({
      port: 0,
      hostname: "127.0.0.1",
      clock: { nowNs: () => 0x1_0000_0005 },
    });
    stops.push(() => {
      handle.server.stop(true);
    });
    const port = handle.server.port;
    if (port === undefined) throw new Error("server has no port");

    const frames: number[][] = [];
    const ws = connectTickClient({
      url: `ws://127.0.0.1:${port}/`,
      onFrame(seq, eventId, priceCents, lineHundredths, lo, hi) {
        frames.push([seq, eventId, priceCents, lineHundredths, lo, hi]);
      },
    });
    stops.push(() => {
      ws.close();
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("tick socket open timeout")),
        5_000,
      );
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("tick socket error"));
      });
    });

    handle.onTick(7, -150, 25);
    handle.onTick(8, 40, -3);

    const deadline = Date.now() + 5_000;
    while (frames.length < 2 && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    expect(frames).toEqual([
      [1, 7, -150, 25, 5, 1],
      [2, 8, 40, -3, 5, 1],
    ]);
  });
});

const mtlsTypeGate = (): void => {
  startTickServer({
    port: 0,
    // @ts-expect-error ca without requestCert is not TickServerTls
    tls: { cert: "cert", key: "key", ca: "ca" },
  });
};
void mtlsTypeGate;
