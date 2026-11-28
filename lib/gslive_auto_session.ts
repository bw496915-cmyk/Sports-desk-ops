/** Auto-mint the GSLive GSID from keychain credentials; no secret is logged or printed. */
import { readFileSync, writeFileSync } from "node:fs";
import {
  type GsliveSessionMeta,
  writeGsliveSessionMeta,
} from "./gslive_session_meta.ts";
import {
  resolveManagerSessionGate,
  writeManagerSessionGate,
} from "./manager_session.ts";
import { getSecretBounded, setSecretBounded } from "./secrets.ts";
import {
  bootstrapGanchrowSession,
  GSID_SECRET,
  SIGNIN_URL,
  USER_AGENT,
} from "../scripts/fetch-bet-tally.ts";

export const GSLIVE_AJAX =
  "https://plive.sportswidgets.pro/manager-tools/ajax.php";
/** Prefix on the error thrown after repeated credential mint failures. */
export const GSLIVE_MINT_LOOP_PREFIX = "GSLive_MINT_LOOP:";
/** Automated credential login is blocked (Cloudflare bot management). */
export const GSLIVE_CLOUDFLARE_BLOCKED_PREFIX = "CLOUDFLARE_BLOCKED:";
export const GSLIVE_MANUAL_GSID_ACTION =
  "printf '%s' '<GSID>' | bun run secrets:gslive set";
export const GSLIVE_MANUAL_GATE_ACTION =
  "printf '%s' '<ganchrowSessionId>' | bun run secrets:gslive set-gate";
export const GSLIVE_MANUAL_DUAL_AUTH_ACTION = `${GSLIVE_MANUAL_GSID_ACTION}; ${GSLIVE_MANUAL_GATE_ACTION}`;

export function gsliveCloudflareBlockedError(): Error {
  return new Error(
    `${GSLIVE_CLOUDFLARE_BLOCKED_PREFIX} GSLive automated login is blocked by Cloudflare. ` +
      "You must manually extract the GSID from your browser and run: " +
      GSLIVE_MANUAL_GSID_ACTION,
  );
}

export function isGsliveCloudflareBlockedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith(GSLIVE_CLOUDFLARE_BLOCKED_PREFIX)
  );
}

function isCloudflareBlockedSignin(res: Response, text: string): boolean {
  const trimmed = text.trim();
  if (/cf-challenge|cf-mitigated|__cf_bm/i.test(text)) return true;
  if (trimmed.startsWith("<") && /cloudflare/i.test(text)) return true;
  if (res.status === 200 && trimmed === "") return true;
  if (res.status === 403) {
    if (/username or password are incorrect/i.test(text)) return false;
    return true;
  }
  return false;
}
import type { SessionCircuitState } from "./onepassword_session_bridge.ts";
import { createStateMachine, defineStateGraph } from "./state_machine.ts";

export const GSLIVE_AUTO_SESSION_STATES = [
  "uninitialized",
  "probing",
  "verified",
  "minting",
  "open_locked",
] as const;
export type GsliveAutoSessionStateKind =
  (typeof GSLIVE_AUTO_SESSION_STATES)[number];

export const GSLIVE_AUTO_SESSION_GRAPH = defineStateGraph(
  "GsliveAutoSession",
  GSLIVE_AUTO_SESSION_STATES,
  {
    uninitialized: ["probing", "minting", "verified", "uninitialized"],
    probing: ["verified", "minting", "uninitialized"],
    verified: ["probing", "minting", "verified", "uninitialized"],
    minting: ["verified", "uninitialized", "open_locked"],
    open_locked: ["uninitialized", "verified"],
  },
);

type GsliveAutoSessionSnapshot =
  | { readonly kind: "uninitialized"; readonly failures: number }
  | {
      readonly kind: "probing";
      readonly candidateGsid: string;
      readonly failures: number;
      readonly flight: Promise<string>;
    }
  | { readonly kind: "verified"; readonly gsid: string }
  | {
      readonly kind: "minting";
      readonly failures: number;
      readonly flight: Promise<string>;
    }
  | {
      readonly kind: "open_locked";
      readonly failures: number;
      readonly lockedError: Error;
    };

const sessionMachine = createStateMachine<GsliveAutoSessionSnapshot>({
  graph: GSLIVE_AUTO_SESSION_GRAPH,
  initial: { kind: "uninitialized", failures: 0 },
});

const gsidRotationHooks = new Set<() => void>();

function currentFailures(snap: GsliveAutoSessionSnapshot): number {
  switch (snap.kind) {
    case "verified":
      return 0;
    case "uninitialized":
    case "probing":
    case "minting":
    case "open_locked":
      return snap.failures;
  }
}

export function getGsliveSessionStateKind(): GsliveAutoSessionStateKind {
  return sessionMachine.kind;
}

/** Maps the internal session machine onto the canonical GATE-AUTH-03 circuit state. */
export function getGsliveSessionCircuitState(): SessionCircuitState {
  const snap = sessionMachine.state;
  switch (snap.kind) {
    case "open_locked":
      return "OPEN_LOCKED";
    case "probing":
    case "minting":
      return "HALF_OPEN_PROBING";
    case "uninitialized":
      return snap.failures > 0 ? "HALF_OPEN_PROBING" : "CLOSED_HEALTHY";
    case "verified":
      return "CLOSED_HEALTHY";
  }
}

export function gsliveConsecutiveMintFailures(): number {
  return currentFailures(sessionMachine.state);
}

/** Test-only reset for mint-failure streak and circuit lock accounting. */
export function resetGsliveMintFailureStreakForTests(): void {
  const snap = sessionMachine.state;
  if (snap.kind === "verified") return;
  sessionMachine.transition(
    { kind: "uninitialized", failures: 0 },
    "reset_failures",
  );
}

/** Register a callback when a fresh GSID is persisted; returns an unsubscribe function. */
export function registerGsidRotationHook(fn: () => void): () => void {
  gsidRotationHooks.add(fn);
  return () => {
    gsidRotationHooks.delete(fn);
  };
}

/** Drop the in-process GSID memo (daemon cache after keychain rotation) and reopen circuit if locked. */
export function resetGsliveAutoSessionCache(): void {
  const snap = sessionMachine.state;
  const failures = snap.kind === "open_locked" ? 0 : currentFailures(snap);
  sessionMachine.transition({ kind: "uninitialized", failures }, "reset_cache");
}

function notifyGsidRotated(): void {
  for (const hook of gsidRotationHooks) {
    hook();
  }
}
const SESSION_FILE = () => (Bun.env.GSLIVE_SESSION_FILE ?? "").trim();
function readSessionFile(): string | null {
  const path = SESSION_FILE();
  if (path === "") return null;
  try {
    const value = readFileSync(path, "utf8").trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}
function writeSessionFile(value: string): void {
  const path = SESSION_FILE();
  if (path === "") return;
  try {
    writeFileSync(path, value, { mode: 0o600 });
  } catch {
    /* best effort */
  }
}
async function secret(name: string): Promise<string | null> {
  try {
    return await getSecretBounded(Bun.secrets, {
      service: "com.bookdeskops.sportsdesk",
      name,
    });
  } catch {
    // Locked or timed-out keychain is treated as absent so session-file/env fallbacks apply.
    return null;
  }
}
export async function getGsid(): Promise<string | null> {
  const snap = sessionMachine.state;
  if (snap.kind === "verified") return snap.gsid;
  const fromFile = readSessionFile();
  if (fromFile !== null && fromFile !== "") return fromFile;
  const fromKeychain =
    (await secret(GSID_SECRET.name)) ?? (await secret("GSID"));
  return fromKeychain !== null && fromKeychain !== "" ? fromKeychain : null;
}
/** Injectable credential reader so tests never touch the real keychain. */
export interface GsliveCredentialReader {
  get(name: "GSLIVE_USERNAME" | "GSLIVE_PASSWORD"): Promise<string | null>;
}

const keychainCredentialReader: GsliveCredentialReader = {
  get: (name) => secret(name),
};

async function probe(
  gsid: string,
  fetchImpl: typeof fetch,
  sessionGate = "",
): Promise<boolean> {
  const headers: Record<string, string> = {
    cookie: `GSID=${gsid}`,
    "content-type": "application/x-www-form-urlencoded",
  };
  // The SPA sends the bootstrap id as `x-gs-session`; ajax.php can reject a valid GSID without it.
  if (sessionGate !== "") headers["x-gs-session"] = sessionGate;
  try {
    const res = await fetchImpl(GSLIVE_AJAX, {
      method: "POST",
      headers,
      body: new URLSearchParams({
        action: "getBetLog",
        betId: "0",
        partnerId: "118",
      }).toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status >= 300 && res.status < 400) return false;
    const text = await res.text();
    return (
      res.ok &&
      text.trim().startsWith("{") &&
      !/login|unauthor|forbidden/i.test(text.slice(0, 400))
    );
  } catch {
    return false;
  }
}

interface SigninWirePayload {
  readonly gsid: string;
  readonly sessionGate: string;
  readonly meta: GsliveSessionMeta | null;
}

function gsidFromSetCookie(res: Response): string {
  const cookies =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie") ?? ""];
  for (const cookie of cookies) {
    const m = /(?:^|;\s*)GSID=([^;]+)/i.exec(cookie);
    if (m !== null) return decodeURIComponent(m[1] as string);
  }
  return "";
}

function metaFromSigninJson(
  json: Record<string, unknown>,
): GsliveSessionMeta | null {
  const adminUserName = json.adminUserName;
  if (typeof adminUserName !== "string" || adminUserName.trim() === "") {
    return null;
  }
  const partner = json.partner;
  return {
    adminUserName: adminUserName.trim(),
    updatedAt: new Date().toISOString(),
    ...(typeof json.agentName === "string" && json.agentName.trim() !== ""
      ? { agentName: json.agentName.trim() }
      : {}),
    ...(typeof partner === "string" || typeof partner === "number"
      ? { partner }
      : {}),
    ...(typeof json.tickerUrl === "string" && json.tickerUrl.trim() !== ""
      ? { tickerUrl: json.tickerUrl.trim() }
      : {}),
  };
}

function parseCredentialSigninResponse(
  res: Response,
  text: string,
): SigninWirePayload {
  let gsid = gsidFromSetCookie(res);
  let sessionGate = "";
  let meta: GsliveSessionMeta | null = null;
  const trimmed = text.trim();
  if (trimmed === "") {
    if (gsid === "") {
      throw new Error(
        `GSLive auth failed: empty sign-in body (HTTP ${res.status})`,
      );
    }
    return { gsid, sessionGate, meta };
  }
  if (trimmed.startsWith("<") || trimmed.startsWith("<!")) {
    if (gsid === "") {
      throw new Error(
        `GSLive auth failed: sign-in returned HTML (HTTP ${res.status})`,
      );
    }
    return { gsid, sessionGate, meta };
  }
  try {
    const json = JSON.parse(trimmed) as Record<string, unknown>;
    const gate = json.ganchrowSessionId;
    if (typeof gate === "string" && gate.trim() !== "") {
      sessionGate = gate.trim();
    }
    if (gsid === "") {
      const fromBody = json.GSID ?? json.gsid ?? json.ganchrowSessionId;
      if (fromBody !== undefined && fromBody !== null) {
        gsid = String(fromBody).trim();
      }
    }
    meta = metaFromSigninJson(json);
  } catch {
    if (gsid === "") {
      throw new Error(
        `GSLive auth failed: invalid response (HTTP ${res.status})`,
      );
    }
  }
  return { gsid, sessionGate, meta };
}

async function verifyMintedGsid(
  fetchImpl: typeof fetch,
  gsid: string,
  sessionGate: string,
  options?: { readonly signinEmptyBody?: boolean },
): Promise<{ gsid: string; gate: string }> {
  if (sessionGate !== "") {
    if (await probe(gsid, fetchImpl, sessionGate)) {
      return { gsid, gate: sessionGate };
    }
    if (
      gsid !== sessionGate &&
      (await probe(sessionGate, fetchImpl, sessionGate))
    ) {
      return { gsid: sessionGate, gate: sessionGate };
    }
    throw new Error(
      "GSLive signin returned a session that did not verify against ajax.php",
    );
  }
  if (await probe(gsid, fetchImpl, "")) {
    return { gsid, gate: "" };
  }
  try {
    const gate = await bootstrapGanchrowSession({
      cookieHeader: `GSID=${gsid}`,
      fetchImpl,
    });
    if (await probe(gsid, fetchImpl, gate)) {
      return { gsid, gate };
    }
  } catch {
    /* credential JSON should have carried ganchrowSessionId; bootstrap is legacy */
  }
  if (options?.signinEmptyBody === true && sessionGate === "") {
    throw gsliveCloudflareBlockedError();
  }
  throw new Error(
    "GSLive signin did not establish a verifiable session; provision GSID manually: " +
      GSLIVE_MANUAL_GSID_ACTION,
  );
}

export async function mintGsid(
  fetchImpl: typeof fetch = fetch,
  credentials: GsliveCredentialReader = keychainCredentialReader,
): Promise<string> {
  const username = await credentials.get("GSLIVE_USERNAME");
  const password = await credentials.get("GSLIVE_PASSWORD");
  if (
    username === null ||
    username === "" ||
    password === null ||
    password === ""
  ) {
    throw new Error(
      "GSLive username/password are not in Bun.secrets (service com.bookdeskops.sportsdesk)",
    );
  }
  // The SPA logs in with JSON `{username,password}` to the signin endpoint. The older
  // `ajax.php action=login` path returned a pre-auth GSID that failed every getBetReport call.
  const res = await fetchImpl(SIGNIN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      referer: "https://plive.sportswidgets.pro/manager-tools/",
      "user-agent": USER_AGENT,
    },
    body: JSON.stringify({ username, password }),
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    if (isCloudflareBlockedSignin(res, text)) {
      throw gsliveCloudflareBlockedError();
    }
    throw new Error(
      `GSLive rejected the keychain credentials (HTTP ${res.status}); update ` +
        "GSLIVE_USERNAME/GSLIVE_PASSWORD or provision GSLIVE_SESSION_ID",
    );
  }
  if (!res.ok) {
    if (isCloudflareBlockedSignin(res, text)) {
      throw gsliveCloudflareBlockedError();
    }
    throw new Error(`GSLive signin returned HTTP ${res.status}`);
  }
  const parsed = parseCredentialSigninResponse(res, text);
  if (parsed.gsid === "") {
    if (isCloudflareBlockedSignin(res, text)) {
      throw gsliveCloudflareBlockedError();
    }
    throw new Error(
      "GSLive auth failed: no GSID in headers or JSON body. Check credentials.",
    );
  }
  const verified = await verifyMintedGsid(
    fetchImpl,
    parsed.gsid,
    parsed.sessionGate,
    { signinEmptyBody: text.trim() === "" },
  );
  const gsid = verified.gsid;
  // Persist only after verification, so a failed login never overwrites a usable session.
  sessionMachine.transition({ kind: "verified", gsid }, "mint_verified");
  try {
    await setSecretBounded(Bun.secrets, {
      service: "com.bookdeskops.sportsdesk",
      name: GSID_SECRET.name,
      value: gsid,
      persist: "local",
    } as never);
  } catch {
    // Best effort: keychain writes are denied (ERR_SECRETS_PLATFORM_ERROR) in some sandboxes.
  }
  if (parsed.meta !== null) {
    await writeGsliveSessionMeta(parsed.meta).catch(() => {
      /* observability only */
    });
  }
  if (verified.gate !== "") {
    await writeManagerSessionGate(verified.gate);
  }
  writeSessionFile(gsid);
  notifyGsidRotated();
  return gsid;
}

async function probeExistingGsid(
  existing: string,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const storedGate = await resolveManagerSessionGate();
  if (storedGate !== "" && (await probe(existing, fetchImpl, storedGate))) {
    return true;
  }
  try {
    const gate = await bootstrapGanchrowSession({
      cookieHeader: `GSID=${existing}`,
      fetchImpl,
    });
    if (await probe(existing, fetchImpl, gate)) {
      await writeManagerSessionGate(gate);
      return true;
    }
  } catch {
    // Expired or gate-less: caller will evict and fall through to credential mint.
  }
  return false;
}

export async function ensureGsid(
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const current = sessionMachine.state;
  if (current.kind === "probing" || current.kind === "minting") {
    return current.flight;
  }

  // When OPEN_LOCKED, refuse repeated credential sign-in POSTs unless an operator manually
  // provisioned a working GSID into GSLIVE_SESSION_FILE or the keychain.
  if (current.kind === "open_locked") {
    const manualCandidate = await getGsid();
    if (
      manualCandidate !== null &&
      manualCandidate !== "" &&
      (await probeExistingGsid(manualCandidate, fetchImpl))
    ) {
      sessionMachine.transition(
        { kind: "verified", gsid: manualCandidate },
        "manual_recovery_verified",
      );
      return manualCandidate;
    }
    throw current.lockedError;
  }

  const priorFailures = currentFailures(current);
  const existing = await getGsid();

  if (existing !== null && existing !== "") {
    let probeFlight!: Promise<string>;
    probeFlight = (async (): Promise<string> => {
      const ok = await probeExistingGsid(existing, fetchImpl);
      if (ok) {
        if (sessionMachine.kind !== "verified") {
          sessionMachine.transition(
            { kind: "verified", gsid: existing },
            "probe_verified",
          );
        }
        return existing;
      }
      // Evict stale memoized GSID immediately so external file/keychain rotations aren't shadowed.
      if (
        sessionMachine.kind === "probing" ||
        sessionMachine.kind === "verified"
      ) {
        sessionMachine.transition(
          { kind: "uninitialized", failures: priorFailures },
          "probe_expired_evict",
        );
      }
      // If we just evicted an in-memory verified GSID, check whether file/keychain already holds a newer rotated GSID.
      if (current.kind === "verified") {
        const rotated = await getGsid();
        if (
          rotated !== null &&
          rotated !== "" &&
          rotated !== existing &&
          (await probeExistingGsid(rotated, fetchImpl))
        ) {
          sessionMachine.transition(
            { kind: "verified", gsid: rotated },
            "external_rotation_verified",
          );
          return rotated;
        }
      }
      return runMintTransition(fetchImpl, priorFailures);
    })();
    sessionMachine.transition(
      {
        kind: "probing",
        candidateGsid: existing,
        failures: priorFailures,
        flight: probeFlight,
      },
      "probe_start",
    );
    return probeFlight;
  }

  return runMintTransition(fetchImpl, priorFailures);
}

function runMintTransition(
  fetchImpl: typeof fetch,
  priorFailures: number,
): Promise<string> {
  let mintFlight!: Promise<string>;
  mintFlight = (async (): Promise<string> => {
    try {
      const gsid = await mintGsid(fetchImpl);
      if (sessionMachine.kind !== "verified") {
        sessionMachine.transition({ kind: "verified", gsid }, "mint_ok");
      }
      return gsid;
    } catch (err) {
      if (isGsliveCloudflareBlockedError(err)) {
        const cfErr = err instanceof Error ? err : new Error(String(err));
        sessionMachine.transition(
          {
            kind: "open_locked",
            failures: priorFailures + 1,
            lockedError: cfErr,
          },
          "cloudflare_blocked",
        );
        throw cfErr;
      }
      const nextFailures = priorFailures + 1;
      if (nextFailures >= 3) {
        const loopErr = new Error(
          `${GSLIVE_MINT_LOOP_PREFIX} Credentials rejected by portal. Rotate password.`,
          { cause: err },
        );
        sessionMachine.transition(
          {
            kind: "open_locked",
            failures: nextFailures,
            lockedError: loopErr,
          },
          "mint_loop_tripped",
        );
        throw loopErr;
      }
      sessionMachine.transition(
        { kind: "uninitialized", failures: nextFailures },
        "mint_failed",
      );
      throw err;
    }
  })();
  sessionMachine.transition(
    { kind: "minting", failures: priorFailures, flight: mintFlight },
    "mint_start",
  );
  return mintFlight;
}
export async function fetchBetLog(
  betId: string,
  gsid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const res = await fetchImpl(GSLIVE_AJAX, {
    method: "POST",
    headers: {
      cookie: `GSID=${gsid}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      action: "getBetLog",
      betId,
      partnerId: "118",
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  return res.json();
}
export async function fetchEventLog(
  betId: string,
  eventId: string,
  logTime: string,
  gsid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const res = await fetchImpl(GSLIVE_AJAX, {
    method: "POST",
    headers: {
      cookie: `GSID=${gsid}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      action: "getEventLog",
      betId,
      eventId,
      logTime,
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  return res.json();
}
