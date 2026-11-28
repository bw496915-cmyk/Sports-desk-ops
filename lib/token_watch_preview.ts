/**
 * @file token_watch_preview.ts
 * @description Live-preview WebSocket hub for the token-watch pipeline.
 *
 * The hub owns the connected preview sockets and fans one payload out with an explicit delivery
 * report, so a caller can tell a clean frame from a lagging client instead of trusting `send()`.
 * The return convention is Bun 1.4.4's measured one (see `lib/ws_backpressure.ts`): `send()`
 * returns the bytes queued (`> 0`), `-1` once the socket is over its backpressure limit, and `0`
 * when the frame was dropped.
 *
 * A `-1` marks that client paused and calls `pause()`; Bun's `drain` event (`websocket.drain`)
 * calls `resume()` and clears the marker. `message` answers the literal `PING` text frame with
 * `PONG` and ignores every other client frame, because the preview feed is server-push.
 */

/** The slice of `ServerWebSocket` the hub drives. */
export interface PreviewSocket {
  send(data: string | Uint8Array): number;
  pause(): void;
  resume(): void;
  close(code?: number, reason?: string): void;
}

/** The `Bun.serve` `websocket` handler shape, narrowed to {@link PreviewSocket}. */
export interface PreviewWebSocketHandlers {
  open(ws: PreviewSocket): void;
  message(ws: PreviewSocket, message: string | Buffer): void;
  drain(ws: PreviewSocket): void;
  close(ws: PreviewSocket): void;
  error(error: unknown, ws: PreviewSocket): void;
}

/** One broadcast's delivery report; `paused` clients did not receive the frame. */
export interface PreviewBroadcastResult {
  readonly delivered: number;
  readonly paused: number;
  readonly dropped: number;
}

/** The live-preview hub the integration drives. */
export interface PreviewHub {
  readonly websocket: PreviewWebSocketHandlers;
  broadcast(payload: string | Uint8Array): PreviewBroadcastResult;
  readonly clients: number;
  closeAll(code?: number, reason?: string): void;
}

/** RFC 6455 "internal server error": the close code a failed preview connection carries. */
export const PREVIEW_CLOSE_FAILURE = 1011;

/** Text heartbeat a preview client may send; answered with {@link PREVIEW_PONG}. */
export const PREVIEW_PING = "PING";

/** Reply to {@link PREVIEW_PING}. */
export const PREVIEW_PONG = "PONG";

/** Close reason attached to {@link PREVIEW_CLOSE_FAILURE}. */
export const PREVIEW_FAILURE_REASON = "preview failed";

/** Close a socket without letting a socket that throws during teardown escape. */
function closeQuietly(ws: PreviewSocket, code: number, reason?: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // The socket is already unusable; forgetting it is the part that matters.
  }
}

export function createPreviewHub(): PreviewHub {
  const sockets = new Set<PreviewSocket>();
  const paused = new Set<PreviewSocket>();

  const forget = (ws: PreviewSocket): void => {
    sockets.delete(ws);
    paused.delete(ws);
  };

  const websocket: PreviewWebSocketHandlers = {
    open(ws) {
      sockets.add(ws);
    },
    message(ws, message) {
      if (typeof message !== "string" || message !== PREVIEW_PING) return;
      try {
        ws.send(PREVIEW_PONG);
      } catch {
        forget(ws);
        closeQuietly(ws, PREVIEW_CLOSE_FAILURE, PREVIEW_FAILURE_REASON);
      }
    },
    drain(ws) {
      if (!paused.delete(ws)) return;
      try {
        ws.resume();
      } catch {
        // A socket we can no longer resume is unusable; close it so closeAll cannot miss it.
        forget(ws);
        closeQuietly(ws, PREVIEW_CLOSE_FAILURE, PREVIEW_FAILURE_REASON);
      }
    },
    close(ws) {
      forget(ws);
    },
    error(_error, ws) {
      closeQuietly(ws, PREVIEW_CLOSE_FAILURE, PREVIEW_FAILURE_REASON);
      forget(ws);
    },
  };

  return {
    websocket,
    broadcast(payload) {
      let delivered = 0;
      let pausedCount = 0;
      let dropped = 0;
      // Snapshot the set: a send fault removes its socket part-way through the loop.
      // Array.from (not a spread) keeps the snapshot explicit and satisfies no-useless-spread.
      for (const ws of Array.from(sockets)) {
        let status: number;
        try {
          status = ws.send(payload);
        } catch {
          // One bad socket must not abort the fan-out to the rest.
          forget(ws);
          closeQuietly(ws, PREVIEW_CLOSE_FAILURE, PREVIEW_FAILURE_REASON);
          dropped += 1;
          continue;
        }
        if (status > 0) {
          delivered += 1;
        } else if (status === 0) {
          // Bun drops the frame past the limit but leaves the connection open, so the client
          // stays in the hub; `closeAll` is the caller's explicit teardown.
          dropped += 1;
        } else if (status === -1) {
          pausedCount += 1;
          if (!paused.has(ws)) {
            paused.add(ws);
            try {
              ws.pause();
            } catch {
              // A socket that cannot pause gets no benefit of the doubt.
              paused.delete(ws);
              forget(ws);
              closeQuietly(ws, PREVIEW_CLOSE_FAILURE, PREVIEW_FAILURE_REASON);
              pausedCount -= 1;
              dropped += 1;
            }
          }
        } else {
          // Any other result carries no delivery guarantee.
          dropped += 1;
        }
      }
      return { delivered, paused: pausedCount, dropped };
    },
    get clients() {
      return sockets.size;
    },
    closeAll(code = PREVIEW_CLOSE_FAILURE, reason) {
      const closing = [...sockets];
      sockets.clear();
      paused.clear();
      for (const ws of closing) closeQuietly(ws, code, reason);
    },
  };
}
