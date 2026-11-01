import { describe, expect, test } from "bun:test";
import { parseNpmrc, registryFor, registryHost } from "../lib/npm_registry.ts";

const NPMRC = `# comment
registry=https://registry.npmjs.org/
@tennis-hq:registry=http://127.0.0.1:50851/
//127.0.0.1:50851/:_authToken=\${TENNIS_NPM_TOKEN}
@other:registry=https://npm.pkg.github.com/
`;

describe("npmrc registry resolution", () => {
  test("parses the default registry and scopes", () => {
    const config = parseNpmrc(NPMRC);
    expect(config.defaultRegistry).toBe("https://registry.npmjs.org/");
    expect(config.scopes).toEqual({
      "@tennis-hq": "http://127.0.0.1:50851/",
      "@other": "https://npm.pkg.github.com/",
    });
  });

  test("routes a scoped name to its registry and everything else to the default", () => {
    const config = parseNpmrc(NPMRC);
    expect(registryFor("@tennis-hq/sportsdesk-workspace", config)).toBe(
      "http://127.0.0.1:50851/",
    );
    expect(registryFor("@other/pkg", config)).toBe(
      "https://npm.pkg.github.com/",
    );
    expect(registryFor("left-pad", config)).toBe("https://registry.npmjs.org/");
    expect(registryFor("@unscoped/name", config)).toBe(
      "https://registry.npmjs.org/",
    );
  });

  test("ignores auth lines and comments", () => {
    const config = parseNpmrc(NPMRC);
    expect(Object.keys(config.scopes)).not.toContain(
      "//127.0.0.1:50851/:_authToken",
    );
    expect(config.defaultRegistry).not.toContain("token");
  });

  test("last registry line wins, like npm", () => {
    const config = parseNpmrc("registry=https://a/\nregistry=https://b/\n");
    expect(config.defaultRegistry).toBe("https://b/");
  });

  test("registryHost strips credentials and a trailing slash", () => {
    expect(registryHost("https://user:pass@example.com/npm/")).toBe(
      "https://example.com/npm",
    );
  });

  test("no config means no registry", () => {
    expect(registryFor("@x/y", parseNpmrc(""))).toBeNull();
  });
});
