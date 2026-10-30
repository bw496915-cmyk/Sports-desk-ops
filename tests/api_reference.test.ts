import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, "..");
const openApiPath = resolve(rootDir, "docs/openapi.json");
const htmlPath = resolve(rootDir, "docs/index.html");
const mdPath = resolve(rootDir, "docs/api-reference.md");

describe("SportsDesk & Fantasy402 API Documentation Suite", () => {
  it("ensures docs/openapi.json exists and is valid OpenAPI 3.1.0", () => {
    assert.equal(existsSync(openApiPath), true, "openapi.json must exist");
    const raw = readFileSync(openApiPath, "utf-8");
    const spec = JSON.parse(raw);

    assert.equal(spec.openapi, "3.1.0");
    assert.ok(spec.info.title.includes("SportsDesk & Fantasy402"));
    assert.ok(spec.servers.length >= 3, "Must declare Cloud, Local Daemon, and Partner 118 servers");
    assert.ok(spec.paths);
  });

  it("verifies all remaining endpoints across all 4 operational domains are present", () => {
    const spec = JSON.parse(readFileSync(openApiPath, "utf-8"));
    const paths = Object.keys(spec.paths);

    const requiredEndpoints = [
      // 1. Upstream Cloud Core
      "/cloud/api/System/authenticateCustomer",
      "/cloud/api/Manager/getBetTicker",
      "/cloud/api/Manager/getBetTickerConfig",
      "/cloud/api/Manager/getPending",
      "/cloud/api/Manager/getWebLog",
      "/cloud/api/Manager/search",
      "/cloud/api/Manager/updateByColumn",
      "/cloud/api/Manager/getInfoPlayer",
      "/cloud/api/Manager/vigSetupInsert",
      "/cloud/api/Manager/getSportsVigSetup",
      "/cloud/api/Manager/getInfoManager",
      "/cloud/api/Report/getWeeklyFigure",
      "/cloud/api/Report/getAgentPerformance",
      "/cloud/api/Report/getSettledFigure",
      "/cloud/api/Report/delete-wager",

      // 2. Local Desk Daemon & Telegram Gateway
      "/health",
      "/api/watchlist",
      "/api/telegram/alert",
      "/api/telegram/report",

      // 3. Desk HITL Security
      "/api/desk/auth/session",
      "/api/desk/hitl/approve",

      // 4. Cross-Book Steam Join
      "/manager-tools/ajax.php",
    ];

    for (const ep of requiredEndpoints) {
      assert.ok(paths.includes(ep), `Missing required endpoint: ${ep}`);
    }
  });

  it("verifies getWebLog contract matches operational_guardrails_runbook.md § 5.1.1", () => {
    const spec = JSON.parse(readFileSync(openApiPath, "utf-8"));
    const webLogOp = spec.paths["/cloud/api/Manager/getWebLog"]?.post;

    assert.ok(webLogOp, "getWebLog POST operation must exist");
    const schema = webLogOp.requestBody.content["application/x-www-form-urlencoded"].schema;
    assert.ok(schema.required.includes("type"));
    assert.ok(schema.required.includes("operation"));
    assert.ok(schema.required.includes("agentID"));
    assert.deepEqual(schema.properties.type.enum, ["A", "B", "C", "I"]);
  });

  it("verifies updateByColumn requires 11-char padded ID and direct sub-agent", () => {
    const spec = JSON.parse(readFileSync(openApiPath, "utf-8"));
    const updateOp = spec.paths["/cloud/api/Manager/updateByColumn"]?.post;

    assert.ok(updateOp, "updateByColumn POST operation must exist");
    const schema = updateOp.requestBody.content["application/x-www-form-urlencoded"].schema;
    assert.ok(schema.required.includes("customerID"));
    assert.ok(schema.required.includes("agentID"));
    assert.ok(schema.required.includes("agentOwner"));
    assert.equal(schema.properties.customerID.example, "CB112_1    ");
  });

  it("verifies HITL HMAC approval route schema and constant-time token requirement", () => {
    const spec = JSON.parse(readFileSync(openApiPath, "utf-8"));
    const hitlOp = spec.paths["/api/desk/hitl/approve"]?.post;

    assert.ok(hitlOp, "HITL approval POST operation must exist");
    const schema = hitlOp.requestBody.content["application/json"].schema;
    assert.ok(schema.required.includes("approvalToken"));
    assert.ok(schema.required.includes("customerIdentifier"));
    assert.ok(schema.required.includes("proposedLimitAmountCents"));
  });

  it("verifies request parameters and security response headers are declared", () => {
    const spec = JSON.parse(readFileSync(openApiPath, "utf-8"));

    // Check request parameter headers
    const params = spec.components.parameters;
    assert.ok(params.AuthBearer, "Must declare AuthBearer component");
    assert.ok(params.XRequestedWith, "Must declare XRequestedWith component");
    assert.ok(params.AcceptJson, "Must declare AcceptJson component");
    assert.ok(params.ReferrerPolicyNoReferrer, "Must declare ReferrerPolicyNoReferrer component");

    // Check response security headers
    const headers = spec.components.headers;
    assert.ok(headers.CSPHeader, "Must declare CSPHeader component");
    assert.ok(headers.XContentTypeOptionsHeader, "Must declare XContentTypeOptionsHeader component");
    assert.ok(headers.ReferrerPolicyHeader, "Must declare ReferrerPolicyHeader component");
  });

  it("ensures docs/index.html loads openapi.json cleanly via modern viewer", () => {
    assert.equal(existsSync(htmlPath), true, "docs/index.html must exist");
    const html = readFileSync(htmlPath, "utf-8");
    assert.ok(html.includes("openapi.json"));
    assert.ok(!html.includes("redoc.standalone.js"), "Must not use legacy redoc with import.meta error");
  });

  it("ensures docs/api-reference.md documents all domains and references openapi.json", () => {
    assert.equal(existsSync(mdPath), true, "docs/api-reference.md must exist");
    const md = readFileSync(mdPath, "utf-8");
    assert.ok(md.length > 2000, "api-reference.md must be populated");
    assert.ok(md.includes("Authorization"), "Must document Authorization header");
    assert.ok(md.includes("getWebLog"), "Must document getWebLog endpoint");
    assert.ok(md.includes("vigSetupInsert"), "Must document vigSetupInsert endpoint");
    assert.ok(md.includes("hitl/approve"), "Must document hitl/approve route");
    assert.ok(md.includes("PaddedCustomerId"), "Must document PaddedCustomerId rule");
  });
});
