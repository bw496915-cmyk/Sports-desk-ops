import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DAEMON_ROUTES } from "../lib/daemon_routes.ts";

/**
 * A public route must not serve an artifact that contains identifiers.
 *
 * `dataClass` is a judgement, so a wrong judgement passes the type: the guarded/unguarded union
 * only rejects declaring `customer-identifying` data as public, not declaring it `aggregate` when
 * it is not. That is exactly what happened — five graph routes were classified `aggregate` and
 * served `docs/graph.html`, whose 640 KB payload carries BILLY666, RF2003, BGD101, CUB22HR and
 * MM800. A probe for the word "login" in the markup returned false, because the page has no such
 * label.
 *
 * So this checks values, not schema: it reads the artifact each file-serving arm points at and
 * fails if a public route serves one that contains a known identifier.
 *
 * Scope: arms that call `Bun.file(resolve(repoRoot, …))` directly. Pages loaded once at startup
 * into a const (the dashboard, the mini app) are not visible to this scan, which is why the table
 * must still be right about them.
 */

const ROOT = resolve(import.meta.dir, "..");
const SOURCE = readFileSync(
  resolve(ROOT, "services/sportsdesk_webview_server.ts"),
  "utf8",
);

/** Identifiers known to appear in this repo's captured artifacts. */
const KNOWN_IDENTIFIERS = [
  "BILLY666",
  "RF2003",
  "BGD101",
  "CUB22HR",
  "MM800",
  "BIGDAD",
  "ATEAM",
] as const;

/**
 * Arm → the repo-relative file it serves, read from the source.
 *
 * An arm is a `pathname === "…"` comparison; the file is the nearest `docs/…` path inside it.
 * Ranges are found by brace matching from the arm, so multi-line conditions are handled.
 */
function fileServingArms(source: string): Map<string, string> {
  const lines = source.split("\n");
  const map = new Map<string, string>();

  for (let i = 0; i < lines.length; i++) {
    if (!/^ {6}if \(/.test(lines[i] ?? "")) continue;

    // Walk the condition to its closing paren, then to the opening brace, so an `if (` whose
    // paths and file both sit on continuation lines is handled like a one-liner.
    let depth = 0;
    let opened = false;
    let j = i;
    const head: string[] = [];
    for (; j < lines.length; j++) {
      const text = lines[j] ?? "";
      head.push(text);
      for (const ch of text) {
        if (ch === "(") depth += 1;
        else if (ch === ")") depth -= 1;
        else if (ch === "{" && depth === 0) {
          opened = true;
          break;
        }
      }
      if (opened) break;
    }
    if (!opened) continue;

    const paths = [...head.join("\n").matchAll(/pathname === "([^"]+)"/g)].map(
      (m) => m[1] ?? "",
    );
    if (paths.length === 0) continue;

    let bodyDepth = 1;
    const body: string[] = [];
    for (let k = j + 1; k < lines.length && bodyDepth > 0; k++) {
      const text = lines[k] ?? "";
      body.push(text);
      bodyDepth +=
        (text.match(/\{/g) ?? []).length - (text.match(/\}/g) ?? []).length;
    }
    const bodyText = body.join("\n");

    // "Serves" means the arm returns the file. An arm that opens an artifact to answer a
    // question about it — /api/analysis reads data/agent-tree.json to say whether a name is
    // known — is not serving that artifact, and counting it produced a false positive.
    if (!/new Response\(/.test(bodyText) || !/Bun\.file\(/.test(bodyText))
      continue;
    const file = /Bun\.file\(\s*resolve\(repoRoot,\s*"([^"]+)"\s*\)/.exec(
      bodyText,
    )?.[1];
    if (file === undefined) continue;
    for (const path of paths) map.set(path, file);
  }
  return map;
}

describe("public routes do not serve identifiers", () => {
  const arms = fileServingArms(SOURCE);
  const byPath = new Map(DAEMON_ROUTES.map((route) => [route.path, route]));

  test("the scan finds the file-serving arms it is meant to cover", () => {
    // Fail on absent rather than coercing to zero: an empty map would make every assertion below
    // vacuously true, which is how a checker quietly stops checking.
    expect(arms.size).toBeGreaterThanOrEqual(4);
    expect([...arms.keys()]).toContain("/graph");
    expect([...arms.keys()]).toContain("/graph-live-feed.json");
  });

  test("no guard-free route serves an artifact containing a known identifier", () => {
    const offenders: string[] = [];
    for (const [path, file] of arms) {
      const route = byPath.get(path);
      if (route === undefined || route.guard !== "none") continue;
      let text: string;
      try {
        text = readFileSync(resolve(ROOT, file), "utf8");
      } catch {
        continue; // artifact not present in this checkout
      }
      const found = KNOWN_IDENTIFIERS.filter((identifier) =>
        text.includes(identifier),
      );
      if (found.length > 0)
        offenders.push(`${path} serves ${file} with ${found.join(",")}`);
    }
    expect(offenders).toEqual([]);
  });

  test("the graph artifacts are recorded as customer-identifying", () => {
    // Pins the classification that the check above depends on: if someone changes it back to
    // aggregate, this fails even though the guard would still be present.
    for (const path of [
      "/graph",
      "/graph.html",
      "/graph-live-feed.json",
      "/api/graph-feed",
    ]) {
      const route = byPath.get(path);
      expect(route?.dataClass).toBe("customer-identifying");
      expect(route?.guard).not.toBe("none");
    }
  });
});
