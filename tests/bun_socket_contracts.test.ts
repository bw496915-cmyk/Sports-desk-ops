/**
 * @file tests/bun_socket_contracts.test.ts
 * @description Pins the Bun TCP socket behaviours the ops daemons depend on:
 * `write()` on a closed socket, `connectError` alongside the rejected promise,
 * and what `binaryType` actually delivers.
 *
 * Measured on `Bun 1.4.4+38afee6c8` (2026-11-17):
 *
 *   binaryType: "arraybuffer"            -> ArrayBuffer
 *   binaryType: "buffer"  (the default)  -> Buffer
 *   binaryType: "uint8array"             -> Uint8Array, and NOT a Buffer
 *
 * The last distinction is the one that matters: `Buffer` extends `Uint8Array`,
 * so `expect(data).toBeInstanceOf(Uint8Array)` passes for the default mode as
 * well and pins nothing. These assertions use the constructor that actually
 * differs.
 *
 * Delivery is awaited through the handler, never `Bun.sleep`, and every server
 * and client is closed in `finally` so a failed assertion cannot leak a
 * listener and hang the runner.
 */

import { describe, expect, test } from "bun:test";

import {
  type BinaryType,
  type ClassifiedBinaryPayload,
  classifyBinaryPayload,
  createSocketBinaryHandler,
} from "../src/lib/binary_type.ts";

/** Connects, sends three bytes, and returns what the server's handler received. */
async function deliveredFor(
  binaryType: BinaryType | undefined,
): Promise<ClassifiedBinaryPayload> {
  let received: ClassifiedBinaryPayload | undefined;
  let settle: (() => void) | undefined;
  const arrived = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket:
      binaryType === undefined
        ? {
            data(_socket, data) {
              received = classifyBinaryPayload(data);
              settle?.();
            },
          }
        : createSocketBinaryHandler(binaryType, {
            data(_socket, data) {
              received = classifyBinaryPayload(data);
              settle?.();
            },
          }),
  });

  const client = await Bun.connect({
    hostname: "127.0.0.1",
    port: server.port,
    socket: { data() {} },
  });

  try {
    client.write(new Uint8Array([1, 2, 3]));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`no data delivered (binaryType=${String(binaryType)})`),
          ),
        2_000,
      );
    });
    try {
      await Promise.race([arrived, timeout]);
    } finally {
      clearTimeout(timer);
    }
    if (received === undefined) {
      throw new Error("handler ran without recording a payload");
    }
    return received;
  } finally {
    client.close();
    server.stop(true);
  }
}

describe("Bun TCP socket contracts", () => {
  test("write() on a closed socket returns -1, and a partial-write loop stops", async () => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    const client = await Bun.connect({
      hostname: "127.0.0.1",
      port: server.port,
      socket: { data() {}, connectError() {} },
    });

    try {
      client.close();
      expect(client.write("x")).toBe(-1);

      // A loop that treats -1 as "keep trying" would spin forever.
      const payload = new TextEncoder().encode("hello");
      let written = 0;
      let iterations = 0;
      while (written < payload.length && iterations < 100) {
        const n = client.write(payload.subarray(written));
        iterations++;
        if (n < 0) break;
        written += n;
      }
      expect(written).toBeLessThan(payload.length);
      expect(iterations).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("connectError fires and the promise still rejects", async () => {
    // A deterministic refusal: bind, learn the port, stop, then connect there.
    // Port 1 is not guaranteed closed on every runner.
    const holder = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    const deadPort = holder.port;
    holder.stop(true);

    let called = false;
    await expect(
      Bun.connect({
        hostname: "127.0.0.1",
        port: deadPort,
        socket: {
          data() {},
          connectError(_socket, _error) {
            called = true;
          },
        },
      }),
    ).rejects.toBeDefined();
    expect(called).toBe(true);
  });

  test("binaryType default delivers Buffer, not a bare Uint8Array", async () => {
    const delivered = await deliveredFor(undefined);
    expect(delivered.isBuffer).toBe(true);
    expect(delivered.ctor).toBe("Buffer");
    expect(delivered.isArrayBuffer).toBe(false);
  });

  test("binaryType uint8array delivers a Uint8Array that is not a Buffer", async () => {
    // `toBeInstanceOf(Uint8Array)` alone would pass for the default Buffer mode.
    const delivered = await deliveredFor("uint8array");
    expect(delivered.isUint8Array).toBe(true);
    expect(delivered.isBuffer).toBe(false);
    expect(delivered.ctor).toBe("Uint8Array");
  });

  test("binaryType buffer delivers Buffer", async () => {
    const delivered = await deliveredFor("buffer");
    expect(delivered.isBuffer).toBe(true);
    expect(delivered.ctor).toBe("Buffer");
  });

  test("binaryType arraybuffer delivers an ArrayBuffer", async () => {
    const delivered = await deliveredFor("arraybuffer");
    expect(delivered.isArrayBuffer).toBe(true);
    expect(delivered.isUint8Array).toBe(false);
    expect(delivered.byteLength).toBe(3);
  });
});

async function udpDeliveredFor(
  binaryType: BinaryType | undefined,
): Promise<ClassifiedBinaryPayload> {
  let received: ClassifiedBinaryPayload | undefined;
  let settle: (() => void) | undefined;
  const arrived = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const receiver = await (binaryType === undefined
    ? Bun.udpSocket({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
          data(_socket, data) {
            received = classifyBinaryPayload(data);
            settle?.();
          },
        },
      })
    : Bun.udpSocket({
        hostname: "127.0.0.1",
        port: 0,
        binaryType,
        socket: {
          data(_socket, data) {
            received = classifyBinaryPayload(data);
            settle?.();
          },
        },
      }));

  const sender = await Bun.udpSocket({
    hostname: "127.0.0.1",
    port: 0,
  });

  try {
    sender.send(new Uint8Array([4, 5, 6]), receiver.port, "127.0.0.1");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `no UDP data delivered (binaryType=${String(binaryType)})`,
            ),
          ),
        2_000,
      );
    });
    try {
      await Promise.race([arrived, timeout]);
    } finally {
      clearTimeout(timer);
    }
    if (received === undefined) {
      throw new Error("UDP handler ran without recording a payload");
    }
    return received;
  } finally {
    sender.close();
    receiver.close();
  }
}

describe("Bun UDP socket BinaryType contracts", () => {
  test("UDP binaryType default delivers Buffer", async () => {
    const delivered = await udpDeliveredFor(undefined);
    expect(delivered.kind).toBe("buffer");
    expect(delivered.isBuffer).toBe(true);
    expect(delivered.byteLength).toBe(3);
  });

  test("UDP binaryType uint8array delivers bare Uint8Array, not Buffer", async () => {
    const delivered = await udpDeliveredFor("uint8array");
    expect(delivered.kind).toBe("uint8array");
    expect(delivered.isUint8Array).toBe(true);
    expect(delivered.isBuffer).toBe(false);
    expect(delivered.byteLength).toBe(3);
  });

  test("UDP binaryType arraybuffer delivers ArrayBuffer", async () => {
    const delivered = await udpDeliveredFor("arraybuffer");
    expect(delivered.kind).toBe("arraybuffer");
    expect(delivered.isArrayBuffer).toBe(true);
    expect(delivered.isUint8Array).toBe(false);
    expect(delivered.byteLength).toBe(3);
  });

  test("connected UDP socket exposes remoteAddress, ReceiveFlags, and connected sendMany()", async () => {
    const received: Array<{
      readonly text: string;
      readonly truncated: boolean;
      readonly ipv6: boolean;
    }> = [];
    let settle: (() => void) | undefined;
    const allArrived = new Promise<void>((resolve) => {
      settle = resolve;
    });

    const server = await Bun.udpSocket({
      hostname: "127.0.0.1",
      port: 0,
      binaryType: "uint8array",
      socket: {
        data(_sock, data, _port, _addr, flags) {
          received.push({
            text: new TextDecoder().decode(data),
            truncated: flags.truncated,
            ipv6: flags.ipv6,
          });
          if (received.length === 3) settle?.();
        },
      },
    });

    const client = await Bun.udpSocket({
      hostname: "127.0.0.1",
      port: 0,
      binaryType: "uint8array",
      connect: {
        hostname: "127.0.0.1",
        port: server.port,
      },
    });

    try {
      expect(server.binaryType).toBe("uint8array");
      // Bun 1.4.5 quirk: `binaryType` is only applied when a `socket` handler is provided.
      expect(client.binaryType).toBe("buffer");
      expect(client.remoteAddress.port).toBe(server.port);
      expect(client.remoteAddress.address).toBe("127.0.0.1");

      const sentCount = client.sendMany(["alpha", "beta", "gamma"]);
      expect(sentCount).toBe(3);

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("UDP sendMany timeout")),
          2_000,
        );
      });
      try {
        await Promise.race([allArrived, timeout]);
      } finally {
        clearTimeout(timer);
      }

      expect(received.map((r) => r.text).sort()).toEqual([
        "alpha",
        "beta",
        "gamma",
      ]);
      for (const item of received) {
        expect(item.truncated).toBe(false);
        expect(item.ipv6).toBe(false);
      }
    } finally {
      client.close();
      server.close();
    }
  });

  test("unconnected sendMany() uses flat [data, port, ip] triplets and returns packet count", async () => {
    const received: string[] = [];
    let settle: (() => void) | undefined;
    const bothArrived = new Promise<void>((resolve) => {
      settle = resolve;
    });

    const server = await Bun.udpSocket({
      hostname: "127.0.0.1",
      port: 0,
      binaryType: "uint8array",
      socket: {
        data(_sock, data) {
          received.push(new TextDecoder().decode(data));
          if (received.length === 2) settle?.();
        },
      },
    });

    const sender = await Bun.udpSocket({
      hostname: "127.0.0.1",
      port: 0,
    });

    try {
      const sentPackets = sender.sendMany([
        "pkt-1",
        server.port,
        "127.0.0.1",
        "pkt-2",
        server.port,
        "127.0.0.1",
      ]);
      expect(sentPackets).toBe(2);

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("unconnected sendMany timeout")),
          2_000,
        );
      });
      try {
        await Promise.race([bothArrived, timeout]);
      } finally {
        clearTimeout(timer);
      }
      expect(received.sort()).toEqual(["pkt-1", "pkt-2"]);
    } finally {
      sender.close();
      server.close();
    }
  });

  test("UDP socket.reload() requires nested { socket } shape (direct handler is a no-op) and setBroadcast/setTTL work", async () => {
    const events: string[] = [];
    let resolveFirst: (() => void) | undefined;
    let resolveDirect: (() => void) | undefined;
    let resolveNested: (() => void) | undefined;
    const first = new Promise<void>((r) => {
      resolveFirst = r;
    });
    const direct = new Promise<void>((r) => {
      resolveDirect = r;
    });
    const nested = new Promise<void>((r) => {
      resolveNested = r;
    });

    const receiver = await Bun.udpSocket({
      hostname: "127.0.0.1",
      port: 0,
      binaryType: "uint8array",
      socket: {
        data(_sock, data) {
          const text = new TextDecoder().decode(data);
          events.push(`v1:${text}`);
          if (text === "one") resolveFirst?.();
          if (text === "direct") resolveDirect?.();
        },
      },
    });
    const sender = await Bun.udpSocket({
      hostname: "127.0.0.1",
      port: 0,
    });

    try {
      expect(sender.setTTL(64)).toBe(64);
      expect(sender.setBroadcast(true)).toBe(true);
      expect(sender.setBroadcast(false)).toBe(false);

      sender.send("one", receiver.port, "127.0.0.1");
      await first;

      // Direct shape matches bun-types@1.4.5, but runtime silently keeps v1.
      receiver.reload({
        data(_sock, data) {
          events.push(`direct:${new TextDecoder().decode(data)}`);
        },
      });
      sender.send("direct", receiver.port, "127.0.0.1");
      await direct;

      // Nested `{ socket: handler }` actually swaps the UDP handler on Bun 1.4.5.
      receiver.reload({
        socket: {
          data(_sock: unknown, data: Uint8Array) {
            events.push(`v2:${new TextDecoder().decode(data)}`);
            resolveNested?.();
          },
        },
      } as never);
      sender.send("two", receiver.port, "127.0.0.1");
      await nested;

      expect(events).toEqual(["v1:one", "v1:direct", "v2:two"]);
    } finally {
      sender.close();
      receiver.close();
    }
  });

  test("TCP vs UDP invalid binaryType validation contract (Bun 1.4.5)", async () => {
    for (const invalid of ["dataview", "nodebuffer", "blob"] as const) {
      expect(() =>
        Bun.listen({
          hostname: "127.0.0.1",
          port: 0,
          socket: { binaryType: invalid as never, data() {} },
        }),
      ).toThrow(/SocketHandler\.binaryType/);
    }

    for (const invalid of ["dataview", "blob"] as const) {
      // Bun.udpSocket validates binaryType synchronously before returning a Promise.
      expect(() =>
        Bun.udpSocket({
          hostname: "127.0.0.1",
          port: 0,
          binaryType: invalid as never,
          socket: { data() {} },
        }),
      ).toThrow(/binaryType/);
    }

    // Bun 1.4.5 UDP quirk: "nodebuffer" is accepted and normalized to "buffer".
    const normalized = await Bun.udpSocket({
      hostname: "127.0.0.1",
      port: 0,
      binaryType: "nodebuffer" as never,
      socket: { data() {} },
    });
    try {
      expect(normalized.binaryType).toBe("buffer");
    } finally {
      normalized.close();
    }
  });

  test("IPv6 loopback ::1 sets ReceiveFlags.ipv6=true and UDP send() after close() throws", async () => {
    let observed:
      | { readonly addr: string; readonly ipv6: boolean; readonly text: string }
      | undefined;
    let settle: (() => void) | undefined;
    const arrived = new Promise<void>((r) => {
      settle = r;
    });

    const rx = await Bun.udpSocket({
      hostname: "::1",
      port: 0,
      binaryType: "uint8array",
      socket: {
        data(_sock, data, _port, addr, flags) {
          observed = {
            addr,
            ipv6: flags.ipv6,
            text: new TextDecoder().decode(data),
          };
          settle?.();
        },
      },
    });
    const tx = await Bun.udpSocket({ hostname: "::1", port: 0 });
    try {
      expect(tx.send("v6-ping", rx.port, "::1")).toBe(true);
      await Promise.race([
        arrived,
        Bun.sleep(2_000).then(() => {
          throw new Error("IPv6 UDP loopback timeout");
        }),
      ]);
      expect(observed).toEqual({ addr: "::1", ipv6: true, text: "v6-ping" });
    } finally {
      tx.close();
      rx.close();
    }

    // Unlike TCP write() (which returns -1), UDP send() on a closed socket throws.
    expect(tx.closed).toBe(true);
    expect(() => tx.send("after-close", rx.port, "::1")).toThrow(
      /Socket is closed/,
    );
  });

  test("UDP multicast loopback delivers datagrams on 239.255.77.77 via 127.0.0.1", async () => {
    const group = "239.255.77.77";
    let receivedText = "";
    let settle: (() => void) | undefined;
    const arrived = new Promise<void>((r) => {
      settle = r;
    });

    const rx = await Bun.udpSocket({
      hostname: "0.0.0.0",
      port: 0,
      binaryType: "uint8array",
      socket: {
        data(_sock, data) {
          receivedText = new TextDecoder().decode(data);
          settle?.();
        },
      },
    });
    const tx = await Bun.udpSocket({ hostname: "127.0.0.1", port: 0 });
    try {
      expect(rx.addMembership(group, "127.0.0.1")).toBe(true);
      expect(tx.setMulticastTTL(1)).toBe(1);
      expect(tx.setMulticastLoopback(true)).toBe(true);
      expect(tx.setMulticastInterface("127.0.0.1")).toBe(true);

      expect(tx.send("mcast-ping", rx.port, group)).toBe(true);
      await Promise.race([
        arrived,
        Bun.sleep(2_000).then(() => {
          throw new Error("UDP multicast loopback timeout");
        }),
      ]);
      expect(receivedText).toBe("mcast-ping");
      expect(rx.dropMembership(group, "127.0.0.1")).toBe(true);
    } finally {
      tx.close();
      rx.close();
    }
  });
});
