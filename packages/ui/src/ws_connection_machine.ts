/**
 * @file packages/ui/src/ws_connection_machine.ts
 * @description Explicit finite-state machine for the operator dashboard `/ws` live stream.
 * Replaces the one-shot unrecovered WebSocket hook with a StrictMode-safe, generation-fenced
 * state machine (`connecting | connected | reconnecting | disposed`) that automatically
 * reconnects with capped exponential backoff after idle or backpressure closes.
 */

export const DASHBOARD_WS_STATES = [
  "connecting",
  "connected",
  "reconnecting",
  "disposed",
] as const;
export type DashboardWsStateKind = (typeof DASHBOARD_WS_STATES)[number];

export const DASHBOARD_WS_TRANSITIONS: Readonly<
  Record<DashboardWsStateKind, readonly DashboardWsStateKind[]>
> = Object.freeze({
  connecting: Object.freeze(["connected", "reconnecting", "disposed"] as const),
  connected: Object.freeze(["reconnecting", "disposed"] as const),
  reconnecting: Object.freeze(["connecting", "disposed"] as const),
  disposed: Object.freeze([] as const),
});

export function canTransitionDashboardWs(
  from: DashboardWsStateKind,
  to: DashboardWsStateKind,
): boolean {
  return DASHBOARD_WS_TRANSITIONS[from].includes(to);
}

export function assertDashboardWsTransition(
  from: DashboardWsStateKind,
  to: DashboardWsStateKind,
  event?: string,
): void {
  if (!canTransitionDashboardWs(from, to)) {
    const via = event !== undefined ? ` on "${event}"` : "";
    const allowed = DASHBOARD_WS_TRANSITIONS[from].join(", ") || "(terminal)";
    throw new Error(
      `[DashboardWs] invalid state transition "${from}" -> "${to}"${via}; allowed: ${allowed}`,
    );
  }
}

export const DASHBOARD_WS_INITIAL_BACKOFF_MS = 1_000;
export const DASHBOARD_WS_MAX_BACKOFF_MS = 15_000;

export function computeDashboardWsBackoffMs(attempt: number): number {
  const exp = Math.max(0, Math.min(10, Math.trunc(attempt)));
  return Math.min(
    DASHBOARD_WS_MAX_BACKOFF_MS,
    DASHBOARD_WS_INITIAL_BACKOFF_MS * 2 ** exp,
  );
}

export interface DashboardWebSocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

export const WS_READY_STATE_CONNECTING = 0;
export const WS_READY_STATE_OPEN = 1;

export interface StartDashboardWsLifecycleOptions<
  TimerHandle = ReturnType<typeof setTimeout>,
> {
  readonly url: string;
  readonly subscribeTopics: readonly string[];
  readonly onConnectedChange: (connected: boolean) => void;
  readonly onTextMessage: (raw: string) => void;
  readonly createSocket?: (url: string) => DashboardWebSocketLike;
  readonly scheduleTimer?: (fn: () => void, delayMs: number) => TimerHandle;
  readonly clearScheduledTimer?: (timer: TimerHandle) => void;
}

export interface DashboardWsLifecycleHandle {
  readonly state: DashboardWsStateKind;
  readonly generation: number;
  dispose(): void;
}

type WsSnapshot<TimerHandle> =
  | {
      readonly kind: "connecting";
      readonly socket: DashboardWebSocketLike;
      readonly attempt: number;
    }
  | {
      readonly kind: "connected";
      readonly socket: DashboardWebSocketLike;
    }
  | {
      readonly kind: "reconnecting";
      readonly timer: TimerHandle;
      readonly nextAttempt: number;
    }
  | { readonly kind: "disposed" };

export function startDashboardWsLifecycle<
  TimerHandle = ReturnType<typeof setTimeout>,
>(
  options: StartDashboardWsLifecycleOptions<TimerHandle>,
): DashboardWsLifecycleHandle {
  const createSocket =
    options.createSocket ??
    ((url: string) => new WebSocket(url) as unknown as DashboardWebSocketLike);
  const scheduleTimer =
    options.scheduleTimer ??
    (((fn: () => void, delayMs: number) =>
      setTimeout(fn, delayMs)) as unknown as (
      fn: () => void,
      delayMs: number,
    ) => TimerHandle);
  const clearScheduledTimer =
    options.clearScheduledTimer ??
    (((timer: TimerHandle) =>
      clearTimeout(timer as unknown as ReturnType<typeof setTimeout>)) as (
      timer: TimerHandle,
    ) => void);

  let snapshot!: WsSnapshot<TimerHandle>;
  let generation = 0;

  function transition(next: WsSnapshot<TimerHandle>, event: string): void {
    assertDashboardWsTransition(snapshot.kind, next.kind, event);
    snapshot = next;
    generation += 1;
  }

  function bindSocket(socket: DashboardWebSocketLike): void {
    socket.onopen = () => {
      if (snapshot.kind !== "connecting" || snapshot.socket !== socket) {
        socket.close();
        return;
      }
      transition({ kind: "connected", socket }, "ws_open");
      options.onConnectedChange(true);
      try {
        socket.send(
          JSON.stringify({
            action: "subscribe",
            topics: options.subscribeTopics,
          }),
        );
      } catch {
        // signal-honesty: intentional-ignore-ws-subscribe-on-closing
      }
    };

    socket.onmessage = (event) => {
      if (snapshot.kind !== "connected" || snapshot.socket !== socket) return;
      if (typeof event.data !== "string") return;
      options.onTextMessage(event.data);
    };

    socket.onclose = () => {
      if (
        (snapshot.kind !== "connecting" && snapshot.kind !== "connected") ||
        snapshot.socket !== socket
      ) {
        return;
      }
      const wasConnected = snapshot.kind === "connected";
      const attempt = snapshot.kind === "connecting" ? snapshot.attempt : 0;
      if (wasConnected) {
        options.onConnectedChange(false);
      }
      const delayMs = computeDashboardWsBackoffMs(attempt);
      let timerGen = 0;
      const timer = scheduleTimer(() => {
        if (generation !== timerGen || snapshot.kind !== "reconnecting") {
          return;
        }
        const nextSocket = createSocket(options.url);
        transition(
          {
            kind: "connecting",
            socket: nextSocket,
            attempt: snapshot.nextAttempt,
          },
          "backoff_elapsed",
        );
        bindSocket(nextSocket);
      }, delayMs);
      transition(
        {
          kind: "reconnecting",
          timer,
          nextAttempt: attempt + 1,
        },
        "ws_close",
      );
      timerGen = generation;
    };
  }

  const firstSocket = createSocket(options.url);
  snapshot = { kind: "connecting", socket: firstSocket, attempt: 0 };
  bindSocket(firstSocket);

  return {
    get state(): DashboardWsStateKind {
      return snapshot.kind;
    },
    get generation(): number {
      return generation;
    },
    dispose(): void {
      if (snapshot.kind === "disposed") return;
      const prev = snapshot;
      transition({ kind: "disposed" }, "dispose");
      if (prev.kind === "reconnecting") {
        clearScheduledTimer(prev.timer);
        return;
      }
      const sock = prev.socket;
      sock.onmessage = null;
      sock.onclose = null;
      if (sock.readyState === WS_READY_STATE_OPEN) {
        sock.close();
      } else if (sock.readyState === WS_READY_STATE_CONNECTING) {
        // Wait for handshake to finish before closing to avoid browser
        // "WebSocket is closed before the connection is established" warning in React StrictMode
        sock.onopen = () => sock.close();
      }
    },
  };
}
