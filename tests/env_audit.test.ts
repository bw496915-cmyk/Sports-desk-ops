import { describe, expect, test } from "bun:test";
import {
  auditEnv,
  isSecretName,
  parseEnvFile,
  permissionWarning,
} from "../lib/env_audit.ts";

const ENV = `# comment
export F402_BASE_URL=https://fantasy402.com
F402_AGENT_ID=118
F402_PASSWORD="s3cret-value-here"
R2_ACCESS_KEY_ID=abcd1234efgh5678
EMPTY_TOKEN=
QUOTED='single quoted'
INLINE=value # trailing comment
`;

describe("env audit", () => {
  test("classifies names without leaking values", () => {
    expect(isSecretName("F402_PASSWORD")).toBe(true);
    expect(isSecretName("R2_SECRET_ACCESS_KEY")).toBe(true);
    expect(isSecretName("TELEGRAM_BOT_TOKEN")).toBe(true);
    expect(isSecretName("F402_BASE_URL")).toBe(false);
    expect(isSecretName("PORT")).toBe(false);
  });

  test("parses export, quotes, comments and blanks", () => {
    const entries = parseEnvFile(ENV);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    expect(byName.get("F402_BASE_URL")?.value).toBe("https://fantasy402.com");
    expect(byName.get("F402_PASSWORD")?.value).toBe("s3cret-value-here");
    expect(byName.get("QUOTED")?.value).toBe("single quoted");
    expect(byName.get("INLINE")?.value).toBe("value");
    expect(byName.get("EMPTY_TOKEN")?.value).toBe("");
    expect(byName.get("EMPTY_TOKEN")?.isSecret).toBe(true);
  });

  test("finds a secret value in a tracked file, by name and path only", () => {
    const entries = parseEnvFile(ENV);
    const result = auditEnv(entries, [
      { path: "README.md", text: "nothing here" },
      { path: "docs/leak.md", text: "token = s3cret-value-here" },
    ]);
    expect(result.leaks).toEqual([
      { path: "docs/leak.md", name: "F402_PASSWORD" },
    ]);
    // The result never carries the value itself.
    expect(JSON.stringify(result)).not.toContain("s3cret-value-here");
  });

  test("ignores short values that would match by accident", () => {
    const entries = parseEnvFile("SHORT_TOKEN=abc\n");
    const result = auditEnv(entries, [{ path: "x.ts", text: "const abc = 1" }]);
    expect(result.leaks).toEqual([]);
  });

  test("flags a tracked .env and loose permissions", () => {
    const result = auditEnv(parseEnvFile(ENV), [{ path: ".env", text: ENV }]);
    expect(result.envTracked).toBe(true);
    expect(permissionWarning(0o644)).toContain("mode 644");
    expect(permissionWarning(0o600)).toBeNull();
  });
});
