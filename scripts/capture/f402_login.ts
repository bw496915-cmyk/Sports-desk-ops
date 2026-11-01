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

export class MissingF402CredentialsError extends Error {
  constructor() {
    super(
      "F402 login requires F402_AGENT_ID and F402_PASSWORD (values are not printed)",
    );
    this.name = "MissingF402CredentialsError";
  }
}

type Env = Record<string, string | undefined>;

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
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface LoginOutcome {
  readonly loginUrl: string;
  readonly usedSubmitButton: boolean;
}

const PASSWORD_GONE =
  '(() => document.querySelector("input[type=password]") === null)()';

export async function loginF402(
  view: LoginView,
  options: LoginOptions = {},
): Promise<LoginOutcome> {
  const env = options.env ?? process.env;
  const credentials = options.credentials ?? resolveF402Credentials(env);
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

  const hasSubmit =
    (await view.evaluate(
      `(() => document.querySelector(${JSON.stringify(login.submitSelector)}) !== null)()`,
    )) === true;

  await view.fill(login.userSelector, credentials.agentId);
  await view.fill(login.passSelector, credentials.password);
  if (hasSubmit) await view.click(login.submitSelector);
  else await view.press("Enter");

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await view.evaluate(PASSWORD_GONE)) === true) {
      return { loginUrl: login.loginUrl, usedSubmitButton: hasSubmit };
    }
    if (Date.now() >= deadline) {
      throw new Error(
        "F402 login did not complete: password field still present",
      );
    }
    await sleep(pollMs);
  }
}
