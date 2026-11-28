/**
 * Replay transport: primary = FetchSession + session-file cookie; secondary = localhost proxy.
 * A WebView profile is never read (Bun.FetchSession has no dataStore): export it once with
 * `bun run session:login --from-profile <dir>`, then point F402_SESSION_FILE at the result.
 * @deprecated F402_COOKIE — use the session file from a WebView login.
 */

import { join } from "node:path";

import {
  F402_BROWSER_HEADER,
  F402_BROWSER_HEADER_VALUE,
} from "./f402_browser_headers.ts";
import {
  readF402Session,
  refreshF402Session,
  writeF402Session,
} from "./f402_session.ts";

import { createStateMachine, defineStateGraph } from "./state_machine.ts";

export const DEPRECATED_F402_COOKIE_ENV = "F402_COOKIE";

export const F402_REPLAY_TRANSPORT_STATES = [
  "open",
  "reminting_401",
  "closed",
] as const;
export type F402ReplayTransportStateKind =
  (typeof F402_REPLAY_TRANSPORT_STATES)[number];

export const F402_REPLAY_TRANSPORT_GRAPH = defineStateGraph(
  "F402ReplayTransport",
  F402_REPLAY_TRANSPORT_STATES,
  {
    open: ["reminting_401", "closed"],
    reminting_401: ["open", "closed"],
    closed: [],
  },
);

type ReplayTransportSnapshot =
  | { readonly kind: "open" }
  | { readonly kind: "reminting_401"; readonly flight: Promise<void> }
  | { readonly kind: "closed" };

export function resolveF402WebViewProfileDir(
  env: NodeJS.ProcessEnv = Bun.env,
): string {
  const explicit = env.F402_WEBVIEW_PROFILE?.trim();
  if (explicit !== undefined && explicit !== "") return explicit;
  return join(import.meta.dir, "../scratch/f402-manager-webview-profile");
}

export function warnIfDeprecatedCookieEnv(
  env: NodeJS.ProcessEnv = Bun.env,
): void {
  const raw = env[DEPRECATED_F402_COOKIE_ENV]?.trim();
  if (raw === undefined || raw === "") return;
  console.warn(
    `[deprecated] ${DEPRECATED_F402_COOKIE_ENV} is deprecated; use F402_SESSION_FILE (bun run session:login) or F402_REPLAY_PROXY_URL`,
  );
}

export interface F402ReplayTransport {
  readonly label:
    "datastore-fetch-session" | "session-file" | "proxy" | "deprecated-cookie";
  readonly state?: F402ReplayTransportStateKind;
  fetch(url: string, init: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

export interface F402ReplayTransportOptions {
  readonly proxyUrl?: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam: replace the Bun FetchSession wire call. */
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  /** Test seam: replace 401 re-mint (default: `refreshF402Session` + `writeF402Session`). */
  readonly refreshSession?: () => Promise<void>;
  readonly readSession?: () => ReturnType<typeof readF402Session>;
}

export async function createF402ReplayTransport(
  options?: F402ReplayTransportOptions,
): Promise<F402ReplayTransport> {
  const env = options?.env ?? Bun.env;
  warnIfDeprecatedCookieEnv(env);

  const proxyMachine = createStateMachine<ReplayTransportSnapshot>({
    graph: F402_REPLAY_TRANSPORT_GRAPH,
    initial: { kind: "open" },
  });

  const proxy = (
    options?.proxyUrl ??
    env.F402_REPLAY_PROXY_URL?.trim() ??
    ""
  ).replace(/\/$/, "");
  if (proxy !== "") {
    return {
      label: "proxy",
      get state() {
        return proxyMachine.kind;
      },
      async fetch(url: string, init: RequestInit): Promise<Response> {
        if (proxyMachine.kind === "closed") {
          throw new Error("F402ReplayTransport is closed");
        }
        const target = new URL(url);
        const proxyUrl = `${proxy}${target.pathname}${target.search}`;
        // A `Headers` instance has no enumerable own keys, so spreading `init.headers` into a
        // plain object silently dropped every caller header. Normalize, then add the browser
        // header the manager API expects (jQuery sends it for same-origin requests only).
        const headers = new Headers(init.headers);
        if (!headers.has(F402_BROWSER_HEADER)) {
          headers.set(F402_BROWSER_HEADER, F402_BROWSER_HEADER_VALUE);
        }
        headers.set("x-f402-upstream", url);
        return fetch(proxyUrl, { ...init, headers });
      },
      async close(): Promise<void> {
        if (proxyMachine.kind !== "closed") {
          proxyMachine.transition({ kind: "closed" }, "close");
        }
      },
    };
  }

  const bunSession = new Bun.FetchSession({
    tls: { rejectUnauthorized: true },
  });
  const machine = createStateMachine<ReplayTransportSnapshot>({
    graph: F402_REPLAY_TRANSPORT_GRAPH,
    initial: { kind: "open" },
  });

  const readSession = options?.readSession ?? (() => readF402Session());
  let hasObservedSessionFile = readSession() !== null;
  const deprecatedCookie = env[DEPRECATED_F402_COOKIE_ENV]?.trim() ?? "";

  const wireFetch =
    options?.fetchImpl ??
    ((url: string, init: RequestInit) => bunSession.fetch(url, init));

  async function fetchOnce(url: string, init: RequestInit): Promise<Response> {
    if (machine.kind === "closed") {
      throw new Error("F402ReplayTransport is closed");
    }
    const headers = new Headers(init.headers);
    // Every server-side manager call goes through here, so the browser header is attached once
    // instead of being re-remembered by each caller.
    if (!headers.has(F402_BROWSER_HEADER)) {
      headers.set(F402_BROWSER_HEADER, F402_BROWSER_HEADER_VALUE);
    }
    const session = readSession();
    if (session !== null) {
      hasObservedSessionFile = true;
      if (!headers.has("cookie")) headers.set("cookie", session.cookieHeader);
      if (
        !headers.has("authorization") &&
        session.authorizationHeader !== undefined
      ) {
        headers.set("authorization", session.authorizationHeader);
      }
    } else if (deprecatedCookie !== "" && !headers.has("cookie")) {
      headers.set("cookie", deprecatedCookie);
    }
    return wireFetch(url, { ...init, headers });
  }

  async function runRemintOnce(): Promise<void> {
    if (options?.refreshSession !== undefined) {
      await options.refreshSession();
      if (readSession() !== null) hasObservedSessionFile = true;
      return;
    }
    const fresh = await refreshF402Session({ env });
    writeF402Session(fresh);
    hasObservedSessionFile = true;
  }

  function remintAfterUnauthorizedSingleflight(): Promise<void> {
    const snap = machine.state;
    if (snap.kind === "closed") {
      return Promise.reject(new Error("F402ReplayTransport is closed"));
    }
    if (snap.kind === "reminting_401") {
      return snap.flight;
    }
    const flight = runRemintOnce().finally(() => {
      if (machine.kind === "reminting_401") {
        machine.transition({ kind: "open" }, "remint_settled");
      }
    });
    machine.transition({ kind: "reminting_401", flight }, "http_401");
    return flight;
  }

  return {
    get label() {
      return hasObservedSessionFile
        ? "session-file"
        : deprecatedCookie !== ""
          ? "deprecated-cookie"
          : "datastore-fetch-session";
    },
    get state() {
      return machine.kind;
    },
    async fetch(url: string, init: RequestInit): Promise<Response> {
      const isClosed = (): boolean => machine.kind === "closed";
      if (isClosed()) {
        throw new Error("F402ReplayTransport is closed");
      }
      let response = await fetchOnce(url, init);
      if (response.status !== 401 || isClosed()) return response;
      try {
        await remintAfterUnauthorizedSingleflight();
      } catch {
        return response;
      }
      if (isClosed()) {
        throw new Error("F402ReplayTransport is closed");
      }
      response = await fetchOnce(url, init);
      return response;
    },
    async close(): Promise<void> {
      if (machine.kind !== "closed") {
        machine.transition({ kind: "closed" }, "close");
      }
      await bunSession.close();
    },
  };
}

/** @deprecated Prefer {@link createF402ReplayTransport}. */
export function cookieHeaderFromEnv(env: NodeJS.ProcessEnv = Bun.env): string {
  warnIfDeprecatedCookieEnv(env);
  const session = readF402Session();
  if (session !== null) return session.cookieHeader;
  return env[DEPRECATED_F402_COOKIE_ENV]?.trim() ?? "";
}
