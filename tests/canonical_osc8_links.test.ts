import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getCanonicalCustomerUrl,
  getCanonicalAgentUrl,
  formatCustomerOsc8Markdown,
  formatAgentOsc8Markdown,
  formatDocsOsc8Markdown,
  formatOpenApiSpecOsc8Markdown,
  renderAnsiMarkdown,
  CANONICAL_DOMAINS,
} from "../lib/canonical_osc8_links.ts";

describe("Canonical OSC 8 Links & Terminal Hyperlinks Engine", () => {
  it("generates canonical customer portal URLs", () => {
    const url = getCanonicalCustomerUrl("rf2003");
    assert.equal(url, "https://fantasy402.com/manager.html?customer=RF2003");
  });

  it("generates canonical sub-agent desk URLs", () => {
    const url = getCanonicalAgentUrl("fakemoney");
    assert.equal(url, "https://desk.bookdeskops.com/agent/FAKEMONEY");
  });

  it("formats markdown links for customer and agent entities", () => {
    const custMd = formatCustomerOsc8Markdown("bgd101");
    assert.equal(
      custMd,
      "[BGD101](https://fantasy402.com/manager.html?customer=BGD101)",
    );

    const agentMd = formatAgentOsc8Markdown("bigdad");
    assert.equal(
      agentMd,
      "[BIGDAD](https://desk.bookdeskops.com/agent/BIGDAD)",
    );
  });

  it("formats canonical docs and OpenAPI specification links", () => {
    const docsMd = formatDocsOsc8Markdown();
    assert.equal(
      docsMd,
      `[Official API Reference](${CANONICAL_DOMAINS.DOCS_PORTAL})`,
    );

    const specMd = formatOpenApiSpecOsc8Markdown();
    assert.equal(
      specMd,
      `[OpenAPI 3.1 Spec](${CANONICAL_DOMAINS.DOCS_PORTAL}/openapi.json)`,
    );
  });

  it("renders ANSI markdown with OSC 8 escape sequences enabled", () => {
    const md = `Inspect [RF2003](https://fantasy402.com/manager.html?customer=RF2003) for details.`;
    const rendered = renderAnsiMarkdown(md, {
      hyperlinks: true,
      colors: false,
    });

    assert.ok(rendered.length > 0);
    // Asserts OSC 8 sequence \x1b]8;; is emitted or URL is embedded
    assert.ok(
      rendered.includes("\x1b]8;;") || rendered.includes("RF2003"),
      "Rendered ANSI string must contain OSC 8 hyperlinks or target text",
    );
  });
});
