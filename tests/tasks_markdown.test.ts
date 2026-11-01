import { describe, expect, test } from "bun:test";

const GFM = {
  tables: true,
  strikethrough: true,
  tasklists: true,
  autolinks: true,
  tagFilter: true,
  headings: { ids: true },
} as const;

const markdown = await Bun.file("docs/REMAINING_TASKS.md").text();
const html = Bun.markdown.html(markdown, GFM);

describe("remaining-tasks markdown", () => {
  test("every open task carries an id, a done-when and a blocker", () => {
    const open = markdown.match(/^- \[ \] .+$/gm) ?? [];
    expect(open.length).toBeGreaterThan(0);
    for (const line of open) {
      expect(line).toMatch(/^- \[ \] \*\*P[0-2]\.\d /);
    }
    const doneWhen = (markdown.match(/\*\*Done when:\*\*/g) ?? []).length;
    const blockedBy = (markdown.match(/\*\*Blocked by:\*\*/g) ?? []).length;
    const doneItems = (markdown.match(/^- \[x\]/gm) ?? []).length;
    expect(doneWhen + doneItems).toBeGreaterThanOrEqual(open.length);
    expect(blockedBy).toBeGreaterThanOrEqual(open.length);
  });

  test("Bun.markdown renders every task as a GFM checkbox", () => {
    const open = (markdown.match(/^- \[ \]/gm) ?? []).length;
    const done = (markdown.match(/^- \[x\]/gm) ?? []).length;
    const checkboxes = (html.match(/type="checkbox"/g) ?? []).length;
    const checked = (html.match(/type="checkbox"[^>]*checked/g) ?? []).length;
    expect(checkboxes).toBe(open + done);
    expect(checked).toBe(done);
  });

  test("GFM tables render and no renderer placeholder leaks", () => {
    expect(html).toContain("<table>");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("[object Object]");
  });

  test("ANSI rendering keeps task markers and omits HTML", () => {
    const ansi = Bun.markdown.ansi(markdown, { colors: false, columns: 80 });
    expect(ansi).toContain("[ ]");
    expect(ansi).toContain("[x]");
    expect(ansi).not.toContain("<table>");
    expect(ansi).not.toContain('type="checkbox"');
    const colored = Bun.markdown.ansi(markdown, { colors: true, columns: 80 });
    expect(colored).toContain("\u001b[");
  });
});
