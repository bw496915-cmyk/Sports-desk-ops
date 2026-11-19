/**
 * @file token_watch_preview.test.ts
 * @description Contract tests for the token-watch preview hub: fan-out counting, Bun's
 * backpressure pause/resume handshake, the 1011 teardown, and send-fault isolation.
 *
 * The fake sockets are fully deterministic (queued send results, call counters, no timers). The
 * single `Bun.serve` test talks to loopback and gives every step a hard timeout, then always
 * closes the client and stops the server in `finally`.
 */
import { describe, expect, test } from "bun:test";
import {
  createPreviewHub,
  PREVIEW_CLOSE_FAILURE,
  PREVIEW_PING,
  PREVIEW_PONG,
  type PreviewBroadcastResult,
  type PreviewSocket,
} from "../lib/token_watch_preview.ts";

interface CloseCall {
  readonly code: number | undefined;
  readonly reason: string | undefined;
}

/** A socket whose `send` results are scripted by call number (default: one byte delivered). */
class FakeSocket implements PreviewSocket {
  readonly sent: (string | Uint8Array)[] = [];
  readonly closeCalls: CloseCall[] = [];
  pauseCalls = 0;
  resumeCalls = 0;
  pauseThrows = false;
  resumeThrows = false;
  closeThrows = false;
  readonly #send: (data: string | Uint8Array, call: number) => number;

  constructor(
    send: (data: string | Uint8Array, call: number) => number = () => 1,
  ) {
    this.#send = send;
  }

  send(data: string | Uint8Array): number {
    this.sent.push(data);
    return this.#send(data, this.sent.length - 1);
  }

  pause(): void {
    this.pauseCalls += 1;
    if (this.pauseThrows) throw new Error("pause failed");
  }

  resume(): void {
    this.resumeCalls += 1;
    if (this.resumeThrows) throw new Error("resume failed");
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    if (this.closeThrows) throw new Error("close failed");
  }
}

describe("token-watch preview hub", () => {
  test("broadcast fans one frame out to every open socket", () => {
    const hub = createPreviewHub();
    const first = new FakeSocket();
    const second = new FakeSocket();
    hub.websocket.open(first);
    hub.websocket.open(second);
    expect(hub.clients).toBe(2);

    expect(hub.broadcast("frame-1")).toEqual({
      delivered: 2,
      paused: 0,
      dropped: 0,
    });
    expect(first.sent).toEqual(["frame-1"]);
    expect(second.sent).toEqual(["frame-1"]);

    const bytes = new Uint8Array([0x7b, 0x7d]);
    expect(hub.broadcast(bytes)).toEqual({
      delivered: 2,
      paused: 0,
      dropped: 0,
    });
    expect(first.sent.at(-1)).toBe(bytes);

    hub.websocket.close(second);
    expect(hub.clients).toBe(1);
    expect(hub.broadcast("frame-2")).toEqual({
      delivered: 1,
      paused: 0,
      dropped: 0,
    });
    expect(second.sent).toHaveLength(2);
  });

  test("message answers the PING heartbeat and ignores other frames", () => {
    const hub = createPreviewHub();
    const ws = new FakeSocket();
    hub.websocket.open(ws);

    hub.websocket.message(ws, PREVIEW_PING);
    expect(ws.sent).toEqual([PREVIEW_PONG]);
    hub.websocket.message(ws, "SUBSCRIBE preview");
    hub.websocket.message(ws, Buffer.from(PREVIEW_PING));
    expect(ws.sent).toEqual([PREVIEW_PONG]);

    // A heartbeat whose reply throws drops the socket instead of escaping the handler.
    const broken = new FakeSocket(() => {
      throw new Error("send failed");
    });
    hub.websocket.open(broken);
    expect(() => hub.websocket.message(broken, PREVIEW_PING)).not.toThrow();
    expect(hub.clients).toBe(1);
    expect(broken.closeCalls).toEqual([
      { code: PREVIEW_CLOSE_FAILURE, reason: "preview failed" },
    ]);
  });

  test("backpressure pauses once, drain resumes once, then the next frame delivers", () => {
    const hub = createPreviewHub();
    const lagging = new FakeSocket((_data, call) => (call < 2 ? -1 : 7));
    hub.websocket.open(lagging);

    expect(hub.broadcast("frame-1")).toEqual({
      delivered: 0,
      paused: 1,
      dropped: 0,
    });
    expect(lagging.pauseCalls).toBe(1);

    // Still over the limit: the client stays paused and pause() is not called twice.
    expect(hub.broadcast("frame-2")).toEqual({
      delivered: 0,
      paused: 1,
      dropped: 0,
    });
    expect(lagging.pauseCalls).toBe(1);

    hub.websocket.drain(lagging);
    expect(lagging.resumeCalls).toBe(1);
    hub.websocket.drain(lagging);
    expect(lagging.resumeCalls).toBe(1);

    expect(hub.broadcast("frame-3")).toEqual({
      delivered: 1,
      paused: 0,
      dropped: 0,
    });
    expect(hub.clients).toBe(1);
  });

  test("a send returning 0 counts as dropped without removing the socket", () => {
    const hub = createPreviewHub();
    const unreliable = new FakeSocket((_data, call) => (call === 0 ? 0 : 4));
    hub.websocket.open(unreliable);

    expect(hub.broadcast("frame-1")).toEqual({
      delivered: 0,
      paused: 0,
      dropped: 1,
    });
    expect(hub.clients).toBe(1);
    // Bun leaves a zero-return socket open, so the next frame is delivered normally.
    expect(hub.broadcast("frame-2")).toEqual({
      delivered: 1,
      paused: 0,
      dropped: 0,
    });
  });

  test("error closes the client with 1011, forgets it, and later broadcasts skip it", () => {
    const hub = createPreviewHub();
    const failing = new FakeSocket();
    const healthy = new FakeSocket();
    hub.websocket.open(failing);
    hub.websocket.open(healthy);

    hub.websocket.error(new Error("handler exploded"), failing);
    expect(failing.closeCalls).toEqual([
      { code: PREVIEW_CLOSE_FAILURE, reason: "preview failed" },
    ]);
    expect(hub.clients).toBe(1);

    expect(hub.broadcast("after")).toEqual({
      delivered: 1,
      paused: 0,
      dropped: 0,
    });
    expect(failing.sent).toEqual([]);
    expect(healthy.sent).toEqual(["after"]);

    // A close() that throws must not escape the error handler either.
    const stubborn = new FakeSocket();
    stubborn.closeThrows = true;
    hub.websocket.open(stubborn);
    expect(() => hub.websocket.error("boom", stubborn)).not.toThrow();
    expect(hub.clients).toBe(1);
    expect(stubborn.closeCalls).toHaveLength(1);
  });

  test("a throwing send drops only that client and does not abort the fan-out", () => {
    const hub = createPreviewHub();
    const bomb = new FakeSocket(() => {
      throw new Error("send exploded");
    });
    const healthy = new FakeSocket();
    hub.websocket.open(bomb);
    hub.websocket.open(healthy);

    let result: PreviewBroadcastResult = {
      delivered: 0,
      paused: 0,
      dropped: 0,
    };
    expect(() => {
      result = hub.broadcast("frame");
    }).not.toThrow();
    expect(result).toEqual({ delivered: 1, paused: 0, dropped: 1 });
    expect(hub.clients).toBe(1);
    expect(healthy.sent).toEqual(["frame"]);
    expect(bomb.closeCalls).toEqual([
      { code: PREVIEW_CLOSE_FAILURE, reason: "preview failed" },
    ]);

    expect(hub.broadcast("again")).toEqual({
      delivered: 1,
      paused: 0,
      dropped: 0,
    });
  });

  test("closeAll sends the caller's code to every socket and empties the hub", () => {
    const hub = createPreviewHub();
    const first = new FakeSocket();
    const stubborn = new FakeSocket();
    stubborn.closeThrows = true;
    const last = new FakeSocket();
    hub.websocket.open(first);
    hub.websocket.open(stubborn);
    hub.websocket.open(last);

    expect(() => hub.closeAll()).not.toThrow();
    expect(hub.clients).toBe(0);
    expect(first.closeCalls).toEqual([
      { code: PREVIEW_CLOSE_FAILURE, reason: undefined },
    ]);
    expect(last.closeCalls).toEqual([
      { code: PREVIEW_CLOSE_FAILURE, reason: undefined },
    ]);
    expect(stubborn.closeCalls).toHaveLength(1);
    expect(hub.broadcast("after teardown")).toEqual({
      delivered: 0,
      paused: 0,
      dropped: 0,
    });

    const explicit = createPreviewHub();
    const bye = new FakeSocket();
    explicit.websocket.open(bye);
    explicit.closeAll(1000, "preview closing");
    expect(bye.closeCalls).toEqual([{ code: 1000, reason: "preview closing" }]);
  });
});

/** Wait for an in-process condition without assuming event ordering. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("preview hub condition timeout");
    await Bun.sleep(5);
  }
}

function openPreviewClient(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(
      () => reject(new Error("preview client open timeout")),
      5_000,
    );
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve(socket);
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("preview client open failed"));
      },
      { once: true },
    );
  });
}

function nextMessage(socket: WebSocket, timeoutMs = 3_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("preview frame timeout"));
    }, timeoutMs);
    const onMessage = (event: MessageEvent) => {
      cleanup();
      resolve(String(event.data));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
    };
    socket.addEventListener("message", onMessage);
  });
}

function nextClose(socket: WebSocket, timeoutMs = 3_000): Promise<CloseEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("preview close timeout"));
    }, timeoutMs);
    const onClose = (event: CloseEvent) => {
      cleanup();
      resolve(event);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.removeEventListener("close", onClose);
    };
    socket.addEventListener("close", onClose);
  });
}

describe("token-watch preview hub teardown on handler faults", () => {
  test("a socket whose pause() throws is dropped and closed", () => {
    const hub = createPreviewHub();
    const broken = new FakeSocket((_data, call) => (call === 0 ? -1 : 1));
    broken.pauseThrows = true;
    hub.websocket.open(broken);

    expect(hub.broadcast("frame")).toEqual({
      delivered: 0,
      paused: 0,
      dropped: 1,
    });
    expect(hub.clients).toBe(0);
    expect(broken.closeCalls).toEqual([
      { code: PREVIEW_CLOSE_FAILURE, reason: "preview failed" },
    ]);
    // It is gone: a second broadcast cannot reach it.
    expect(hub.broadcast("frame-2")).toEqual({
      delivered: 0,
      paused: 0,
      dropped: 0,
    });
  });

  test("a socket whose resume() throws is dropped and closed on drain", () => {
    const hub = createPreviewHub();
    const lagging = new FakeSocket((_data, call) => (call === 0 ? -1 : 1));
    hub.websocket.open(lagging);
    expect(hub.broadcast("frame")).toEqual({
      delivered: 0,
      paused: 1,
      dropped: 0,
    });

    lagging.resumeThrows = true;
    expect(() => hub.websocket.drain(lagging)).not.toThrow();
    expect(hub.clients).toBe(0);
    expect(lagging.closeCalls).toEqual([
      { code: PREVIEW_CLOSE_FAILURE, reason: "preview failed" },
    ]);
  });
});

describe("token-watch preview hub over a real Bun.serve", () => {
  test("a client receives one frame, then closeAll(1011) closes it with 1011", async () => {
    const hub = createPreviewHub();
    const server = Bun.serve<undefined>({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request, server) {
        if (server.upgrade(request)) return undefined;
        return new Response("upgrade required", { status: 426 });
      },
      websocket: hub.websocket,
    });
    let client: WebSocket | undefined;
    try {
      client = await openPreviewClient(`ws://127.0.0.1:${server.port}/preview`);
      await waitFor(() => hub.clients === 1);

      const frame = nextMessage(client);
      expect(hub.broadcast("hello preview")).toEqual({
        delivered: 1,
        paused: 0,
        dropped: 0,
      });
      expect(await frame).toBe("hello preview");

      const closed = nextClose(client);
      hub.closeAll(1011, "preview closing");
      expect(hub.clients).toBe(0);
      expect((await closed).code).toBe(PREVIEW_CLOSE_FAILURE);
    } finally {
      client?.close();
      server.stop(true);
    }
  }, 15_000);
});
