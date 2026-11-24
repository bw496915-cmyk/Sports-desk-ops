/**
 * @file r2_probe_fetch.test.ts
 * @description The shared R2 read transport. The desk probe and the GitHub Actions alerter both
 * read the same bucket through this module, so these tests pin the two failure modes that made
 * the alerter lie for 15 days: a signed read must not be attempted for a foreign URL, and a
 * presigned URL's signature must never reach an error message.
 */

import { describe, expect, test } from "bun:test";

import {
  createR2S3ProbeFetcher,
  plainR2ProbeFetch,
  resolveR2ProbeTransport,
  type R2ProbeFetcher,
  type R2ProbePresigner,
} from "../lib/r2_probe_fetch.ts";
import { R2_PUBLIC_BASE } from "../lib/r2_staleness.ts";

const KEY_URL = `${R2_PUBLIC_BASE}/gslive-tally/latest.json`;
const SIGNED_URL = "https://signed.example/object?X-Amz-Signature=secret";

describe("createR2S3ProbeFetcher", () => {
  test("signs only public R2 keys and keeps the method", async () => {
    const presigned: {
      key: string;
      method: string | undefined;
      expiresIn: number | undefined;
    }[] = [];
    const fetched: string[] = [];
    const fetcher = createR2S3ProbeFetcher(
      {
        presign: (key, options) => {
          presigned.push({
            key,
            method: options?.method,
            expiresIn: options?.expiresIn,
          });
          return SIGNED_URL;
        },
      },
      async (url) => {
        fetched.push(url);
        return new Response(null, { status: 200 });
      },
    );

    const response = await fetcher(KEY_URL, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(presigned).toEqual([
      { key: "gslive-tally/latest.json", method: "HEAD", expiresIn: 60 },
    ]);
    expect(fetched).toEqual([SIGNED_URL]);
  });

  test("passes a foreign URL through unsigned", async () => {
    const fetched: string[] = [];
    const fetcher = createR2S3ProbeFetcher(
      { presign: () => SIGNED_URL },
      async (url) => {
        fetched.push(url);
        return new Response(null, { status: 200 });
      },
    );

    await fetcher("https://example.test/latest.json", { method: "HEAD" });
    expect(fetched).toEqual(["https://example.test/latest.json"]);
  });

  test("does not leak the signature when the signed request fails", async () => {
    const fetcher = createR2S3ProbeFetcher(
      { presign: () => SIGNED_URL },
      async () => {
        throw new TypeError(`fetch failed for ${SIGNED_URL}`);
      },
    );

    let caught: unknown;
    try {
      await fetcher(KEY_URL, { method: "HEAD" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("gslive-tally/latest.json");
    expect((caught as Error).message).not.toContain("X-Amz-Signature");
    expect((caught as Error).cause).toBe("TypeError");
  });
});

describe("resolveR2ProbeTransport", () => {
  test("an injected fetcher wins and never resolves credentials", async () => {
    const injected: R2ProbeFetcher = async () =>
      new Response(null, { status: 200 });
    let asked = false;
    const transport = await resolveR2ProbeTransport(injected, async () => {
      asked = true;
      return null;
    });

    expect(transport.kind).toBe("injected");
    expect(transport.fetch).toBe(injected);
    expect(asked).toBe(false);
  });

  test("signs when credentials resolve", async () => {
    const presigner: R2ProbePresigner = { presign: () => SIGNED_URL };
    const transport = await resolveR2ProbeTransport(
      undefined,
      async () => presigner,
    );

    expect(transport.kind).toBe("signed");
  });

  test("falls back to the anonymous transport when no credentials resolve", async () => {
    const transport = await resolveR2ProbeTransport(
      undefined,
      async () => null,
    );

    expect(transport.kind).toBe("anonymous");
    expect(transport.fetch).toBe(plainR2ProbeFetch);
  });

  test("falls back to anonymous when the credential lookup throws", async () => {
    const transport = await resolveR2ProbeTransport(undefined, async () => {
      throw new Error("keychain unavailable");
    });

    expect(transport.kind).toBe("anonymous");
  });
});
