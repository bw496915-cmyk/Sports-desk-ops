#!/usr/bin/env bun
/**
 * @file scripts/mcp_dx_server.ts
 * @description stdio MCP server exposing `dx shot` as the `shot` tool over the same capture path as
 * the CLI (scripts/capture/shot.ts).
 *
 * Usage (MCP client config):
 *   { "command": "bun", "args": ["run", "<repo>/scripts/mcp_dx_server.ts"] }
 *
 * The tool only captures public http(s) pages into scratch/shots/: it takes no login, profile,
 * cookie or output-path input, so an MCP client cannot reach a signed-in portal session or write
 * outside the shots directory. Stdout carries the protocol; nothing else may write to it.
 */

import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  captureShotFile,
  DEFAULT_SHOT_DIR,
  defaultShotPath,
  openShotView,
  type ShotFileRequest,
} from "./capture/shot.ts";
import { WebViewError } from "./capture/webview.ts";

const REPO_ROOT = join(import.meta.dir, "..");

export const SHOT_INPUT = {
  url: z.url({ protocol: /^https?$/ }).describe("The http(s) page to capture"),
  backend: z
    .enum(["webkit", "chrome"])
    .optional()
    .describe("webkit (macOS default) or chrome"),
  format: z.enum(["png", "jpeg", "webp"]).optional(),
  width: z.number().int().min(320).max(16384).optional(),
  height: z.number().int().min(240).max(16384).optional(),
  waitSelector: z
    .string()
    .min(1)
    .optional()
    .describe("Wait for this CSS selector before the screenshot"),
  thumb: z
    .number()
    .int()
    .min(16)
    .max(2048)
    .optional()
    .describe("Also write a WebP thumbnail that fits in thumb x thumb px"),
  placeholder: z
    .boolean()
    .optional()
    .describe("Include the ThumbHash data: URL"),
  console: z
    .boolean()
    .optional()
    .describe("Include the redacted page console (at most 200 lines)"),
  retries: z.number().int().min(0).max(5).optional(),
};

type ShotInput = z.infer<z.ZodObject<typeof SHOT_INPUT>>;

export function shotRequest(input: ShotInput): ShotFileRequest {
  const format = input.format ?? "png";
  return {
    url: input.url,
    out: defaultShotPath(format, join(REPO_ROOT, DEFAULT_SHOT_DIR)),
    width: input.width ?? 1440,
    height: input.height ?? 900,
    backend:
      input.backend ?? (process.platform === "darwin" ? "webkit" : "chrome"),
    format,
    encoding: "blob",
    quality: 82,
    resize: null,
    waitSelector: input.waitSelector ?? null,
    waitMs: 250,
    timeoutMs: 20_000,
    retries: input.retries ?? 0,
    f402Login: false,
    f402Page: "/",
    profile: null,
    thumb: input.thumb ?? null,
    placeholder: input.placeholder === true,
    console: input.console === true,
    cookies: false,
  };
}

export async function runShotTool(
  input: ShotInput,
  capture: (request: ShotFileRequest) => Promise<unknown> = async (request) => {
    await using view = await openShotView(request);
    // `await using` disposes on return, so the capture must settle first.
    return await captureShotFile(view, request);
  },
): Promise<CallToolResult> {
  try {
    const result = await capture(shotRequest(input));
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) {
    if (!(error instanceof WebViewError)) throw error;
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: error.code, message: error.message }),
        },
      ],
    };
  }
}

export function createDxMcpServer(): McpServer {
  const server = new McpServer({
    name: "dx",
    version: "1.0.0",
    title: "Sports desk operations",
  });
  server.registerTool(
    "shot",
    {
      title: "Capture a page",
      description:
        "Open a public http(s) URL in Bun.WebView and write a screenshot under scratch/shots/. Returns the dx shot --json result: screenshot path, screenshotUrl, sha256, title, final url, and optional thumb, placeholder and console.",
      inputSchema: SHOT_INPUT,
    },
    (input) => runShotTool(input),
  );
  return server;
}

if (import.meta.main) {
  await createDxMcpServer().connect(new StdioServerTransport());
}
