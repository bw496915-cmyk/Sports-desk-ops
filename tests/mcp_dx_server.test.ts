import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { WebViewError } from "../scripts/capture/webview.ts";
import {
  createDxMcpServer,
  runShotTool,
  shotRequest,
} from "../scripts/mcp_dx_server.ts";

async function connectedClient(): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await createDxMcpServer().connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("dx MCP server", () => {
  test("lists exactly the shot tool, with no login, profile, cookie or path input", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["shot"]);
    const keys = Object.keys(tools[0]!.inputSchema.properties ?? {});
    expect(keys).toContain("url");
    for (const forbidden of [
      "f402Login",
      "profile",
      "cookies",
      "out",
      "encoding",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
    await client.close();
  });

  test("a non-http(s) URL is rejected by the schema before any WebView launches", async () => {
    const client = await connectedClient();
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "nope"]) {
      const result = await client.callTool({
        name: "shot",
        arguments: { url },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(
        "Input validation error",
      );
    }
    await client.close();
  });
});

describe("shotRequest", () => {
  test("never signs in, reads a profile or collects cookies", () => {
    const request = shotRequest({ url: "https://example.com" });
    expect(request.f402Login).toBe(false);
    expect(request.profile).toBeNull();
    expect(request.cookies).toBe(false);
    expect(request.encoding).toBe("blob");
  });

  test("writes under the repo's scratch/shots with the format's extension", () => {
    const request = shotRequest({ url: "https://example.com", format: "jpeg" });
    expect(request.out).toMatch(
      /\/scratch\/shots\/webview-[0-9a-f-]{36}\.jpg$/,
    );
  });
});

describe("runShotTool", () => {
  test("returns the capture result as one JSON text block", async () => {
    const result = await runShotTool(
      { url: "https://example.com" },
      async () => ({
        screenshot: "/tmp/s.png",
      }),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([
      { type: "text", text: '{"screenshot":"/tmp/s.png"}' },
    ]);
  });

  test("a WebView failure becomes an error result carrying its code", async () => {
    const result = await runShotTool(
      { url: "https://example.com" },
      async () => {
        throw new WebViewError("load-timeout", "timed out after 20000ms");
      },
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      error: "load-timeout",
      message: "timed out after 20000ms",
    });
  });

  test("any other error propagates to the SDK", async () => {
    await expect(
      runShotTool({ url: "https://example.com" }, async () => {
        throw new TypeError("bug");
      }),
    ).rejects.toThrow("bug");
  });
});
