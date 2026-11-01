import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  buildDocsManifest,
  renderDocsTree,
  writeDocsManifest,
} from "../lib/docs_render_cache.ts";
import {
  acceptsEncoding,
  createDocsServer,
  type DocsServer,
} from "../lib/docs_server.ts";

const ROOT = `scratch/docs-server-test-${process.pid}`;
const DIR = `${ROOT}/docs`;
const CACHE = `${ROOT}/cache`;
const MANIFEST = join(CACHE, "manifest.json");

let docs: DocsServer;
let key = "";

beforeAll(async () => {
  await Bun.write(`${DIR}/a.md`, "# Alpha\n\nBody **bold**.\n");
  await Bun.write(`${DIR}/b.md`, "# Beta\n\nSecond doc.\n");
  const rendered = await renderDocsTree({ dir: DIR, cacheDir: CACHE });
  await writeDocsManifest(MANIFEST, buildDocsManifest(rendered));
  key = rendered[0]!.key;
  docs = createDocsServer({ cacheDir: CACHE, manifestPath: MANIFEST, port: 0 });
});

afterAll(async () => {
  docs.server.stop(true);
  await rm(ROOT, { recursive: true, force: true });
});

describe("acceptsEncoding", () => {
  test("treats q=0 as a refusal and q>0 as acceptance", () => {
    expect(acceptsEncoding(null, "zstd")).toBe(false);
    expect(acceptsEncoding("", "zstd")).toBe(false);
    expect(acceptsEncoding("gzip, zstd", "zstd")).toBe(true);
    expect(acceptsEncoding("zstd;q=0", "zstd")).toBe(false);
    expect(acceptsEncoding("gzip, zstd;q=0.1", "zstd")).toBe(true);
    expect(acceptsEncoding("gzip, br", "zstd")).toBe(false);
    expect(acceptsEncoding("ZSTD", "zstd")).toBe(true);
  });
});

describe("docs server", () => {
  test("/health reports the manifest build id", async () => {
    const response = await fetch(new URL("/health", docs.url));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      buildId: string;
      entries: number;
    };
    expect(body.ok).toBe(true);
    expect(body.buildId).toHaveLength(64);
    expect(body.entries).toBe(2);
  });

  test("/docs lists both sources", async () => {
    const response = await fetch(new URL("/docs", docs.url));
    const body = (await response.json()) as {
      docs: Array<{ source: string; url: string }>;
    };
    expect(body.docs.map((row) => row.source)).toEqual(["a.md", "b.md"]);
    expect(body.docs[0]?.url).toStartWith("/docs/");
  });

  test("serves plain HTML and varies on Accept-Encoding", async () => {
    const response = await fetch(new URL(`/docs/${key}`, docs.url), {
      headers: { "accept-encoding": "identity" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("vary")?.toLowerCase()).toContain(
      "accept-encoding",
    );
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(await response.text()).toContain("<h1");
  });

  test("negotiates zstd and the body inflates to the HTML", async () => {
    // Bun's fetch decodes zstd automatically; `decompress: false` exposes the wire bytes.
    const response = await fetch(new URL(`/docs/${key}`, docs.url), {
      headers: { "accept-encoding": "zstd" },
      decompress: false,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("zstd");
    expect(response.headers.get("accept-ranges")).toBe("none");
    const raw = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(raw.subarray(0, 4))).toEqual([0x28, 0xb5, 0x2f, 0xfd]);
    const html = new TextDecoder().decode(Bun.zstdDecompressSync(raw));
    expect(html).toBe(await Bun.file(join(CACHE, `${key}.html`)).text());
  });

  test("zstd;q=0 falls back to HTML", async () => {
    const response = await fetch(new URL(`/docs/${key}`, docs.url), {
      headers: { "accept-encoding": "zstd;q=0, gzip" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.text()).toContain("<h1");
  });

  test("a Range request on the zstd body is never a partial stream", async () => {
    const response = await fetch(new URL(`/docs/${key}`, docs.url), {
      headers: { "accept-encoding": "zstd", range: "bytes=0-9" },
      decompress: false,
    });
    expect(response.status).toBe(200);
    const raw = new Uint8Array(await response.arrayBuffer());
    expect(() => Bun.zstdDecompressSync(raw)).not.toThrow();
  });

  test("unknown keys and missing bodies are 404", async () => {
    expect((await fetch(new URL("/docs/deadbeef", docs.url))).status).toBe(404);
    const htmlPath = join(CACHE, `${key}.html`);
    await Bun.file(htmlPath).delete();
    const response = await fetch(new URL(`/docs/${key}`, docs.url), {
      headers: { "accept-encoding": "identity" },
    });
    expect(response.status).toBe(404);
  });

  test("a rewritten manifest is picked up without a restart", async () => {
    await Bun.sleep(5);
    await Bun.write(`${DIR}/b.md`, "# Beta changed\n");
    const rendered = await renderDocsTree({ dir: DIR, cacheDir: CACHE });
    await writeDocsManifest(MANIFEST, buildDocsManifest(rendered));
    const response = await fetch(new URL("/health", docs.url));
    const body = (await response.json()) as { buildId: string };
    expect(body.buildId).toBe(buildDocsManifest(rendered).buildId);

    const changedKey = rendered.find((entry) => entry.rel === "b.md")!.key;
    const doc = await fetch(new URL(`/docs/${changedKey}`, docs.url), {
      headers: { "accept-encoding": "identity" },
    });
    expect(await doc.text()).toContain("Beta changed");
  });
});
