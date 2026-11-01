/**
 * @file scripts/capture/f402_login.ts
 * @description Unattended F402 portal login for WebView-driven capture.
 *
 * Credentials come from `F402_AGENT_ID` / `F402_PASSWORD` only, never argv, and are never printed.
 * Selectors are overridable because the portal markup is not contractual; the defaults live in
 * `resolveLoginConfig`.
 *
 * Completion is decided by the login form disappearing, not by a URL change: the portal can redirect
 * to the same path and still be showing the form.
 */

import { resolveLoginConfig } from "./ops.ts";

export interface F402Credentials {
  readonly agentId: string;
  readonly password: string;
}

export type F402LoginKind = "agent" | "player";

export interface F402LoginIdentity {
  readonly loginId: string;
  readonly password: string;
  readonly kind: F402LoginKind;
}

export class MissingF402CredentialsError extends Error {
  constructor() {
    super(
      "F402 login requires F402_AGENT_ID and F402_PASSWORD (values are not printed)",
    );
    this.name = "MissingF402CredentialsError";
  }
}

type Env = Record<string, string | undefined>;

/** Keychain-backed credential storage, so a password need not sit in `.env`. */
export const SECRETS_SERVICE = "sportsdesk-ops";
export const SECRET_NAMES = {
  agentId: "f402-agent-id",
  password: "f402-password",
  playerId: "f402-player-id",
  playerPassword: "f402-player-password",
} as const;

export interface SecretsReader {
  get(options: { service: string; name: string }): Promise<string | null>;
}

/**
 * Env first, then the OS credential store. Env wins so a one-off run can override without touching
 * the keychain; the fallback means the durable copy can live outside `.env`.
 */
export async function loadF402Credentials(
  env: Env = process.env,
  secrets: SecretsReader | null = Bun.secrets as SecretsReader,
): Promise<F402Credentials> {
  const envAgent = env["F402_AGENT_ID"]?.trim() ?? "";
  const envPassword = env["F402_PASSWORD"]?.trim() ?? "";
  if (envAgent !== "" && envPassword !== "") {
    return { agentId: envAgent, password: envPassword };
  }
  const read = async (name: string): Promise<string> => {
    if (secrets === null) return "";
    try {
      return (
        (await secrets.get({ service: SECRETS_SERVICE, name }))?.trim() ?? ""
      );
    } catch {
      return "";
    }
  };
  const agentId = envAgent !== "" ? envAgent : await read(SECRET_NAMES.agentId);
  const password =
    envPassword !== "" ? envPassword : await read(SECRET_NAMES.password);
  if (agentId === "" || password === "")
    throw new MissingF402CredentialsError();
  return { agentId, password };
}

export async function loadF402PlayerCredentials(
  env: Env = process.env,
  secrets: SecretsReader | null = Bun.secrets as SecretsReader,
): Promise<F402LoginIdentity> {
  const read = async (name: string): Promise<string> => {
    if (secrets === null) return "";
    try {
      return (
        (await secrets.get({ service: SECRETS_SERVICE, name }))?.trim() ?? ""
      );
    } catch {
      return "";
    }
  };
  const envId = env["F402_PLAYER_ID"]?.trim() ?? "";
  const envPass = env["F402_PLAYER_PASSWORD"]?.trim() ?? "";
  const loginId = envId !== "" ? envId : await read(SECRET_NAMES.playerId);
  const password =
    envPass !== "" ? envPass : await read(SECRET_NAMES.playerPassword);
  if (loginId === "" || password === "") {
    throw new MissingF402CredentialsError();
  }
  return { loginId, password, kind: "player" };
}

export async function loadF402LoginIdentity(
  env: Env = process.env,
  kind: F402LoginKind = "agent",
): Promise<F402LoginIdentity> {
  if (kind === "player") {
    return loadF402PlayerCredentials(env);
  }
  const agent = await loadF402Credentials(env);
  return { loginId: agent.agentId, password: agent.password, kind: "agent" };
}

export function resolveF402Credentials(
  env: Env = process.env,
): F402Credentials {
  const agentId = env["F402_AGENT_ID"]?.trim() ?? "";
  const password = env["F402_PASSWORD"]?.trim() ?? "";
  if (agentId === "" || password === "")
    throw new MissingF402CredentialsError();
  return { agentId, password };
}

/** The subset of `ManagedWebView` the login needs; lets tests inject a stub. */
export interface LoginView {
  navigate(
    url: string,
    options?: { allowOpaqueUrl?: boolean; timeoutMs?: number },
  ): Promise<unknown>;
  waitForSelector(
    selector: string,
    options?: { timeoutMs?: number },
  ): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  fill(selector: string, text: string): Promise<void>;
  click(selector: string): Promise<void>;
  press(key: string): Promise<void>;
}

export interface LoginOptions {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly hydrationMs?: number;
  readonly pollMs?: number;
  readonly env?: Env;
  readonly credentials?: F402Credentials;
  readonly loginKind?: F402LoginKind;
  readonly loginIdentity?: F402LoginIdentity;
  readonly beforeSubmitExpression?: string;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface LoginOutcome {
  readonly loginUrl: string;
  readonly usedSubmitButton: boolean;
  readonly agentId: string;
  readonly loginKind: F402LoginKind;
}

const PASSWORD_GONE =
  '(() => document.querySelector("input[type=password]") === null)()';

export async function loginF402(
  view: LoginView,
  options: LoginOptions = {},
): Promise<LoginOutcome> {
  const env = options.env ?? process.env;
  const loginKind = options.loginKind ?? "agent";
  const identity =
    options.loginIdentity ??
    (options.credentials !== undefined
      ? {
          loginId: options.credentials.agentId,
          password: options.credentials.password,
          kind: loginKind,
        }
      : await loadF402LoginIdentity(env, loginKind));
  const baseUrl = (
    options.baseUrl ??
    env["F402_BASE_URL"]?.trim() ??
    "https://www.fantasy402.com"
  ).replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? 20_000;
  const pollMs = options.pollMs ?? 250;
  const hydrationMs =
    options.hydrationMs ?? Number(env["F402_LOGIN_HYDRATION_MS"] ?? "1500");
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));

  const login = resolveLoginConfig(env as Env, baseUrl);
  await view.navigate(login.loginUrl, { allowOpaqueUrl: true, timeoutMs });
  await view.waitForSelector(login.userSelector, { timeoutMs });
  await sleep(Number.isFinite(hydrationMs) ? Math.max(0, hydrationMs) : 1500);

  if (options.beforeSubmitExpression) {
    await view.evaluate(options.beforeSubmitExpression);
  }

  const hasSubmit =
    (await view.evaluate(
      `(() => document.querySelector(${JSON.stringify(login.submitSelector)}) !== null)()`,
    )) === true;

  await view.fill(login.userSelector, identity.loginId);
  await view.fill(login.passSelector, identity.password);
  if (hasSubmit) await view.click(login.submitSelector);
  else await view.press("Enter");

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await view.evaluate(PASSWORD_GONE)) === true) {
      return {
        loginUrl: login.loginUrl,
        usedSubmitButton: hasSubmit,
        agentId: identity.kind === "agent" ? identity.loginId : "",
        loginKind: identity.kind,
      };
    }
    if (Date.now() >= deadline) {
      throw new Error(
        "F402 login did not complete: password field still present",
      );
    }
    await sleep(pollMs);
  }
}
