import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Static checks for the executive dashboard's Live Desk panel. No DOM in `bun:test`, so these
 * assert the wiring: parseable module script, required ids, the endpoints the panel calls, and
 * that the panel does not depend on the Telegram admin token.
 */
describe("static/customer-churn-simulation-dashboard.html", () => {
  const html = readFileSync(
    resolve(
      import.meta.dir,
      "../static/customer-churn-simulation-dashboard.html",
    ),
    "utf8",
  );

  const moduleScript = (() => {
    const blocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
    const inline = blocks.find((b) => (b[1] ?? "").trim().length > 0);
    if (inline?.[1] === undefined) throw new Error("no inline script block");
    return inline[1];
  })();

  /** The panel's own IIFE, located by its first lookup. */
  const panel = (() => {
    const start = moduleScript.indexOf('document.getElementById("live-desk")');
    expect(start).toBeGreaterThan(-1);
    const end = moduleScript.indexOf("})();", start);
    return moduleScript.slice(start, end === -1 ? undefined : end);
  })();

  test("inline module script parses", () => {
    expect(() => new Function(moduleScript)).not.toThrow();
  });

  test("never assigns innerHTML", () => {
    expect(html).not.toContain("innerHTML");
  });

  test("declares the Live Desk hooks the panel looks up", () => {
    for (const id of [
      "live-desk",
      "ld-badge",
      "ld-stats",
      "ld-sports",
      "ld-fixtures",
      "ld-scoreboard",
      "ld-source",
      "ld-refresh",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    for (const id of [
      "ld-badge",
      "ld-stats",
      "ld-sports",
      "ld-fixtures",
      "ld-scoreboard",
      "ld-source",
      "ld-refresh",
    ]) {
      expect(panel).toContain(id);
    }
  });

  test("reads the endpoints the scoreboard exposes", () => {
    for (const path of [
      "/api/live-bets",
      "/api/game-admin",
      "/api/sports",
      "/api/scoreboard",
    ]) {
      expect(panel).toContain(path);
    }
  });

  test("does not gate the panel on the Telegram admin token", () => {
    // On loopback these endpoints are open; anywhere else the server answers 401/503 and the
    // panel reports that explicitly instead of borrowing the bot token form.
    expect(panel).not.toContain("tokenInput");
    expect(panel).not.toContain("Authorization");
    expect(panel).toContain("TOKEN REQUIRED");
  });

  test("labels the data source instead of implying a live feed", () => {
    expect(panel).toContain("CAPTURE");
    expect(panel).toContain("SAMPLE");
    expect(panel).toContain("transcribed");
  });

  test("polls only while visible and sends no cache directive", () => {
    expect(panel).toContain('document.visibilityState === "visible"');
    expect(panel).toContain('cache: "no-store"');
  });
});

describe("Analysis panel", () => {
  const html = readFileSync(
    resolve(
      import.meta.dir,
      "../static/customer-churn-simulation-dashboard.html",
    ),
    "utf8",
  );

  const moduleScript = (() => {
    const blocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
    const inline = blocks.find((b) => (b[1] ?? "").trim().length > 0);
    if (inline?.[1] === undefined) throw new Error("no inline script block");
    return inline[1];
  })();

  const panel = (() => {
    const start = moduleScript.indexOf('document.getElementById("an-form")');
    expect(start).toBeGreaterThan(-1);
    const end = moduleScript.indexOf("})();", start);
    return moduleScript.slice(start, end === -1 ? undefined : end);
  })();

  test("renders the portal's four filter controls plus the agent search", () => {
    for (const id of [
      "analysis",
      "an-form",
      "an-report",
      "an-activity",
      "an-group",
      "an-week",
      "an-agent",
      "an-result",
      "an-badge",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  test("loads the vocabulary from the server instead of hard-coding it twice", () => {
    expect(panel).toContain("/api/analysis/filters");
    expect(panel).toContain("/api/analysis?");
    // No option labels are duplicated in the page; the endpoint is the single source.
    expect(html).not.toContain("Customer Volume</option>");
  });

  test("reports the uncaptured report instead of showing an empty grid", () => {
    expect(panel).toContain("501");
    expect(panel).toContain("NOT CAPTURED");
    expect(panel).toContain("requiredCapture");
  });

  test("surfaces validation errors as a rejection, not a pass", () => {
    expect(panel).toContain("INVALID");
    expect(panel).toContain("issues");
  });
});

describe("Sport catalog panel", () => {
  const html = readFileSync(
    resolve(
      import.meta.dir,
      "../static/customer-churn-simulation-dashboard.html",
    ),
    "utf8",
  );

  const moduleScript = (() => {
    const blocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
    const inline = blocks.find((b) => (b[1] ?? "").trim().length > 0);
    if (inline?.[1] === undefined) throw new Error("no inline script block");
    return inline[1];
  })();

  const panel = (() => {
    const start = moduleScript.indexOf('document.getElementById("sc-list")');
    expect(start).toBeGreaterThan(-1);
    const end = moduleScript.indexOf("})();", start);
    return moduleScript.slice(start, end === -1 ? undefined : end);
  })();

  test("declares the catalog hooks and loads them from the endpoint", () => {
    for (const id of [
      "sport-catalog",
      "sc-badge",
      "sc-list",
      "sc-count",
      "sc-search",
      "sc-expand",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(panel).toContain("/api/sports/catalog");
  });

  test("renders sub-sport codes and per-sport period menus", () => {
    expect(panel).toContain("Sub-sports (code)");
    expect(panel).toContain("Periods (number → name)");
    expect(panel).toContain("sub.code");
    expect(panel).toContain("period.number");
  });

  test("warns about sub-sport codes shared by several sports", () => {
    expect(panel).toContain("collision");
    expect(panel).toContain("Code shared by");
  });

  test("does not hard-code a global period number mapping", () => {
    // A number→name table in the page would mislabel Hockey/Basketball/Baseball periods.
    expect(panel).not.toContain("1st Half");
    expect(panel).not.toContain("1st Quarter");
  });
});

describe("Settings panel", () => {
  const html = readFileSync(
    resolve(
      import.meta.dir,
      "../static/customer-churn-simulation-dashboard.html",
    ),
    "utf8",
  );

  const moduleScript = (() => {
    const blocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
    const inline = blocks.find((b) => (b[1] ?? "").trim().length > 0);
    if (inline?.[1] === undefined) throw new Error("no inline script block");
    return inline[1];
  })();

  test("renders the modal's four controls", () => {
    for (const id of [
      "settings",
      "st-badge",
      "st-notify",
      "st-language",
      "st-timezone",
      "st-agent-menu",
      "st-save",
      "st-reset",
      "st-status",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('data-setting="notify"');
    expect(html).toContain('data-setting="agentMenu"');
  });

  test("keeps the portal's option values", () => {
    expect(html).toMatch(/<option value="Y">On<\/option>/);
    expect(html).toMatch(/<option value="N">Off<\/option>/);
    expect(html).toMatch(/<option value="Chinese \(Simp\)">/);
    expect(html).toMatch(/<option value="3">\(PST\)<\/option>/);
    expect(html).toMatch(/<option value="Tile Menu">/);
  });

  test("applies the time zone to rendered timestamps", () => {
    // A stored preference that changes nothing would make the panel lie.
    expect(moduleScript).toContain("function sdFormatTs");
    expect(moduleScript).toContain("captured ${sdFormatTs(");
    expect(moduleScript).toContain("transcribed ${sdFormatTs(");
    expect(moduleScript).toContain("SD_ZONES");
  });

  test("refreshes panels when settings are saved", () => {
    expect(
      moduleScript.match(/new Event\("sportsdesk-settings"\)/g)?.length,
    ).toBe(2);
    expect(
      moduleScript.match(/addEventListener\("sportsdesk-settings", load\)/g)
        ?.length,
    ).toBe(2);
  });

  test("says which preferences do not change the UI", () => {
    expect(moduleScript).toContain("No strings are translated yet");
    expect(moduleScript).toContain("does not follow US daylight saving");
  });

  test("hides alert dispatch when Wager Alerts is off", () => {
    expect(moduleScript).toContain('settings.notify === "N"');
    expect(moduleScript).toContain('data-action="alert"');
  });
});

describe("Analysis report table", () => {
  const html = readFileSync(
    resolve(
      import.meta.dir,
      "../static/customer-churn-simulation-dashboard.html",
    ),
    "utf8",
  );

  const moduleScript = (() => {
    const blocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
    const inline = blocks.find((b) => (b[1] ?? "").trim().length > 0);
    if (inline?.[1] === undefined) throw new Error("no inline script block");
    return inline[1];
  })();

  test("offers stored reports and a sport filter", () => {
    expect(html).toContain('id="an-stored"');
    expect(html).toContain('id="an-sport"');
    expect(moduleScript).toContain("/api/analysis/reports");
  });

  test("sends the sport with the selection", () => {
    expect(moduleScript).toContain('params.set("sport", sport)');
  });

  test("renders rows, totals and the duplicate marker", () => {
    expect(moduleScript).toContain("an-table");
    expect(moduleScript).toContain("an-dup");
    expect(moduleScript).toContain("body.totals.holdPercent");
  });

  test("surfaces a totals discrepancy rather than hiding it", () => {
    expect(moduleScript).toContain("Totals disagree with the rows in");
    expect(moduleScript).toContain("match the published figures");
  });

  test("fills the form from a report's recorded context", () => {
    expect(moduleScript).toContain("applyStoredContext");
    expect(moduleScript).toContain("context.agent");
  });
});

describe("Live wager ticker panel", () => {
  const html = readFileSync(
    resolve(
      import.meta.dir,
      "../static/customer-churn-simulation-dashboard.html",
    ),
    "utf8",
  );

  const moduleScript = (() => {
    const blocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
    const inline = blocks.find((b) => (b[1] ?? "").trim().length > 0);
    if (inline?.[1] === undefined) throw new Error("no inline script block");
    return inline[1];
  })();

  const panel = (() => {
    const start = moduleScript.indexOf('document.getElementById("lw-rows")');
    expect(start).toBeGreaterThan(-1);
    const end = moduleScript.indexOf("})();", start);
    return moduleScript.slice(start, end === -1 ? undefined : end);
  })();

  test("declares the ticker hooks", () => {
    for (const id of [
      "live-wagers",
      "lw-badge",
      "lw-note",
      "lw-stats",
      "lw-writers",
      "lw-types",
      "lw-rows",
      "lw-count",
      "lw-risk",
      "lw-volume",
      "lw-mismatch",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  test("reads the ticker endpoint and handles its empty state", () => {
    expect(panel).toContain("/api/live-wagers");
    expect(panel).toContain("NOT CAPTURED");
    expect(panel).toContain("data/live-wagers.json");
  });

  test("flags a volume mismatch instead of hiding it", () => {
    expect(panel).toContain("volumeDiffers");
    expect(panel).toContain("lw-vol");
  });

  test("renders one cell per declared column", () => {
    // Nine headers; the Legs cell carries the count and the first leg's label together.
    const headerCount = (html.match(/<th scope="col">/g) ?? []).length;
    expect(headerCount).toBeGreaterThanOrEqual(9);
    expect(panel).toContain("legCell");
    expect(panel).not.toContain('tr.append(make("td", "", ""))');
  });

  test("offers writer and type filters", () => {
    expect(panel).toContain("buildBars");
    expect(panel).toContain("byWriter");
    expect(panel).toContain("byType");
  });

  test("labels a partial list as partial, in the file's own words", () => {
    // A count of 17 must not read as "the ticker showed 17".
    expect(panel).toContain("PARTIAL");
    expect(panel).toContain("provenance.partial");
    expect(panel).toContain("provenance.captureNote");
    expect(panel).toContain("provenance.source");
    // The note comes from the server, not from a sentence invented in the browser.
    expect(panel).not.toContain("subset of the shown list");
  });
});
