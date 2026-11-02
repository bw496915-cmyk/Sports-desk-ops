import { describe, expect, test } from "bun:test";

import {
  WebViewError,
  type WebViewErrorCode,
} from "../scripts/capture/webview.ts";
import {
  boundedInt,
  navigateWithRetry,
  parseSignedOutMarkers,
  renderShotTable,
  toFsPath,
} from "../scripts/webview_shot_cli.ts";

describe("parseSignedOutMarkers", () => {
  test("keeps the known markers in page order", () => {
    expect(parseSignedOutMarkers(["session-expired", "login-form"])).toEqual([
      "session-expired",
      "login-form",
    ]);
  });

  test("drops anything the page returned that is not a known marker", () => {
    expect(
      parseSignedOutMarkers(["login-form", "logged-in", 1, null, {}]),
    ).toEqual(["login-form"]);
  });

  test("a non-array evaluation result means no markers seen", () => {
    for (const value of [undefined, null, "login-form", { 0: "login-form" }]) {
      expect(parseSignedOutMarkers(value)).toEqual([]);
    }
  });
});

describe("toFsPath", () => {
  test("file:// URLs become paths, with percent-escapes decoded", () => {
    expect(toFsPath("file:///tmp/a%20b/shot.png")).toBe("/tmp/a b/shot.png");
  });

  test("plain paths pass through, relative ones stay relative", () => {
    expect(toFsPath("scratch/webview-profile")).toBe("scratch/webview-profile");
    expect(toFsPath("/tmp/x.png")).toBe("/tmp/x.png");
  });
});

describe("boundedInt", () => {
  test("accepts integers inside the range, including both ends", () => {
    expect(boundedInt("16", 16, 2048)).toBe(16);
    expect(boundedInt("2048", 16, 2048)).toBe(2048);
  });

  test("rejects out-of-range, fractional and non-numeric input", () => {
    for (const raw of ["15", "2049", "16.5", "abc", "", "-1"]) {
      expect(boundedInt(raw, 16, 2048)).toBeUndefined();
    }
  });
});

describe("navigateWithRetry", () => {
  function flakyView(failures: number, code: WebViewErrorCode) {
    let calls = 0;
    return {
      get calls() {
        return calls;
      },
      async navigate() {
        calls += 1;
        if (calls <= failures) throw new WebViewError(code, "boom");
        return { url: "https://x", title: "", loading: false };
      },
    };
  }
  const waits: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    waits.push(ms);
  };

  test("retries a failed navigation with growing waits, then succeeds", async () => {
    waits.length = 0;
    const view = flakyView(2, "navigate-failed");
    expect(
      await navigateWithRetry(view, "https://x", {
        timeoutMs: 1000,
        retries: 2,
        sleep,
      }),
    ).toBe(3);
    expect(waits).toEqual([500, 1000]);
  });

  test("gives up after --retries and rethrows the last error", async () => {
    const view = flakyView(5, "load-timeout");
    await expect(
      navigateWithRetry(view, "https://x", {
        timeoutMs: 1000,
        retries: 1,
        sleep,
      }),
    ).rejects.toThrow("boom");
    expect(view.calls).toBe(2);
  });

  test("never retries an error that a retry cannot fix", async () => {
    const view = flakyView(1, "invalid-url");
    await expect(
      navigateWithRetry(view, "https://x", {
        timeoutMs: 1000,
        retries: 3,
        sleep,
      }),
    ).rejects.toThrow("boom");
    expect(view.calls).toBe(1);
  });
});

describe("renderShotTable", () => {
  const base = {
    screenshot: "/tmp/s.png",
    bytes: 10,
    sha256: "ab".repeat(32),
    mimeType: "image/png",
    backend: "webkit",
    format: "png",
    encoding: "blob",
    title: "Manager",
    url: "https://www.fantasy402.com/manager.html",
  } as const;

  test("one row per field, keyed by name, without colour when asked", () => {
    const text = renderShotTable(base, false);
    expect(text).toContain("screenshot");
    expect(text).toContain("webkit (png)");
    expect(text).not.toContain("signedOutMarkers");
    expect(text).not.toContain("\x1b[");
  });

  test("summarises the long fields instead of printing them", () => {
    const text = renderShotTable(
      {
        ...base,
        profile: "/p",
        signedOutMarkers: [],
        placeholder: `data:image/png;base64,${"A".repeat(500)}`,
        console: [{ level: "log", text: "hello" }],
      },
      false,
    );
    expect(text).toContain("none seen");
    expect(text).toContain("522 chars");
    expect(text).toContain("1 line(s)");
    expect(text).not.toContain("AAAA");
    expect(text).not.toContain("hello");
  });
});
