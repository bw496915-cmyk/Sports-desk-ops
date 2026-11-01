import { describe, expect, test } from "bun:test";
import {
  type LoginView,
  MissingF402CredentialsError,
  SECRET_NAMES,
  SECRETS_SERVICE,
  loadF402Credentials,
  loginF402,
  resolveF402Credentials,
} from "../scripts/capture/f402_login.ts";

const ENV = {
  F402_AGENT_ID: "agent-118",
  F402_PASSWORD: "not-a-real-secret",
};

function stubView(overrides: Partial<LoginView> = {}): {
  view: LoginView;
  calls: string[];
} {
  const calls: string[] = [];
  let passwordGone = false;
  const view: LoginView = {
    async navigate(url) {
      calls.push(`navigate:${url}`);
    },
    async waitForSelector(selector) {
      calls.push(`waitFor:${selector}`);
    },
    async evaluate(expression) {
      calls.push(
        `evaluate:${expression.includes("type=password") ? "password-check" : "probe"}`,
      );
      if (expression.includes("!== null")) return true; // submit button present
      if (expression.includes("=== null")) return passwordGone;
      return null;
    },
    async fill(selector, text) {
      calls.push(
        `fill:${selector}:${text === ENV.F402_PASSWORD ? "<password>" : text}`,
      );
    },
    async click(selector) {
      calls.push(`click:${selector}`);
      passwordGone = true;
    },
    async press(key) {
      calls.push(`press:${key}`);
      passwordGone = true;
    },
    ...overrides,
  };
  return { view, calls };
}

const noSleep = async (): Promise<void> => {};

describe("F402 login", () => {
  test("requires both credentials and never echoes a value", () => {
    expect(() => resolveF402Credentials({})).toThrow(
      MissingF402CredentialsError,
    );
    expect(() => resolveF402Credentials({ F402_AGENT_ID: "a" })).toThrow(
      "F402_AGENT_ID and F402_PASSWORD",
    );
    expect(() =>
      resolveF402Credentials({ F402_AGENT_ID: "a", F402_PASSWORD: " " }),
    ).toThrow(MissingF402CredentialsError);
    const credentials = resolveF402Credentials(ENV);
    expect(credentials.agentId).toBe("agent-118");
    expect(credentials.password).toBe(ENV.F402_PASSWORD);
    try {
      resolveF402Credentials({ F402_AGENT_ID: "secret-agent" });
    } catch (error) {
      expect((error as Error).message).not.toContain("secret-agent");
    }
  });

  test("fills both fields, clicks submit, and waits for the form to disappear", async () => {
    const { view, calls } = stubView();
    const outcome = await loginF402(view, {
      credentials: resolveF402Credentials(ENV),
      env: ENV,
      baseUrl: "https://www.fantasy402.com",
      hydrationMs: 0,
      sleep: noSleep,
    });
    expect(outcome.loginUrl).toBe("https://www.fantasy402.com/");
    expect(outcome.usedSubmitButton).toBe(true);
    expect(calls).toContain('fill:input[name="customerID"]:agent-118');
    expect(calls).toContain('fill:input[type="password"]:<password>');
    expect(calls).toContain("click:button.btn.btn-primary");
    expect(calls.some((call) => call.startsWith("press:"))).toBe(false);
  });

  test("falls back to Enter when the submit button is absent", async () => {
    const { view, calls } = stubView({
      async evaluate(expression) {
        if (expression.includes("!== null")) return false;
        return true;
      },
    });
    const outcome = await loginF402(view, {
      credentials: resolveF402Credentials(ENV),
      env: ENV,
      hydrationMs: 0,
      sleep: noSleep,
    });
    expect(outcome.usedSubmitButton).toBe(false);
    expect(calls).toContain("press:Enter");
  });

  test("honours selector overrides and reports a stuck form", async () => {
    const { view, calls } = stubView({
      async evaluate() {
        return false; // form never disappears
      },
    });
    await expect(
      loginF402(view, {
        credentials: resolveF402Credentials(ENV),
        env: {
          ...ENV,
          F402_LOGIN_USER_SELECTOR: "#agent",
          F402_LOGIN_PASS_SELECTOR: "#pin",
        },
        timeoutMs: 5,
        pollMs: 1,
        hydrationMs: 0,
        sleep: noSleep,
      }),
    ).rejects.toThrow("password field still present");
    expect(calls).toContain("fill:#agent:agent-118");
    expect(calls).toContain("fill:#pin:<password>");
  });
});

describe("F402 credential sources", () => {
  const store = new Map<string, string>([
    [`${SECRETS_SERVICE}/${SECRET_NAMES.agentId}`, "keychain-agent"],
    [`${SECRETS_SERVICE}/${SECRET_NAMES.password}`, "keychain-secret"],
  ]);
  const secrets = {
    async get({ service, name }: { service: string; name: string }) {
      return store.get(`${service}/${name}`) ?? null;
    },
  };

  test("environment variables win over the credential store", async () => {
    const credentials = await loadF402Credentials(ENV, secrets);
    expect(credentials.agentId).toBe(ENV.F402_AGENT_ID);
    expect(credentials.password).toBe(ENV.F402_PASSWORD);
  });

  test("falls back to the credential store when env is incomplete", async () => {
    const credentials = await loadF402Credentials(
      { F402_AGENT_ID: "from-env" },
      secrets,
    );
    expect(credentials.agentId).toBe("from-env");
    expect(credentials.password).toBe("keychain-secret");

    const both = await loadF402Credentials({}, secrets);
    expect(both.agentId).toBe("keychain-agent");
    expect(both.password).toBe("keychain-secret");
  });

  test("treats a failing store as absent and never leaks values", async () => {
    await expect(
      loadF402Credentials(
        {},
        {
          async get() {
            throw new Error("keychain locked");
          },
        },
      ),
    ).rejects.toBeInstanceOf(MissingF402CredentialsError);

    await expect(loadF402Credentials({}, null)).rejects.toBeInstanceOf(
      MissingF402CredentialsError,
    );
  });
});
