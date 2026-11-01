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
    const sample = Bun.markdown.html("# T\n\n| A |\n| --- |\n| 1 |");
    expect(sample).not.toContain("undefined");
    expect(sample).not.toContain("[object Object]");
  });

  test("ANSI rendering keeps task markers and omits HTML", () => {
    // `ansi()` takes an AnsiTheme, not parser options. Columns 0 is the no-wrap log mode.
    const ansi = Bun.markdown.ansi(markdown, { colors: false, columns: 0 });
    expect(ansi).toContain("[ ]");
    expect(ansi).toContain("[x]");
    expect(ansi).not.toContain("<table>");
    expect(ansi).not.toContain('type="checkbox"');
    expect(ansi).not.toContain("\u001b[");
    const colored = Bun.markdown.ansi(markdown, { colors: true, columns: 0 });
    expect(colored).toContain("\u001b[");
  });

  test("HTML options sanitize tags and add heading IDs", () => {
    expect(html).toContain("id=");
    const sanitized = Bun.markdown.html("<script>alert(1)</script>\n\n# Hi", {
      tagFilter: true,
      headings: { ids: true },
    });
    expect(sanitized).not.toContain("<script>");
    expect(sanitized).toContain('id="hi"');
  });

  test("render(): listItem.checked distinguishes bullets from task state", () => {
    const seen: Array<boolean | undefined> = [];
    Bun.markdown.render(
      "- plain\n- [ ] open\n- [x] done\n",
      {
        listItem: (_children, meta) => {
          seen.push(meta.checked);
          return "";
        },
      },
      { tasklists: true },
    );
    expect(seen).toEqual([undefined, false, true]);
  });

  test("the zero-code CLI loader renders the document", async () => {
    const proc = Bun.spawn(["bun", "docs/REMAINING_TASKS.md"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out).toContain("Remaining tasks");
    expect(out).toContain("P0.1");
  });
});
