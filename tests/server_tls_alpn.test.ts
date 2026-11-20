/**
 * @file tests/server_tls_alpn.test.ts
 * @description Opt-in TLS listener: HTTPS routing with a generated CA/server
 * certificate and an ALPNProtocols configuration on Bun.serve. Skips when
 * openssl is unavailable.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";

import { startServer } from "../services/sportsdesk_webview_server.ts";
import { createTlsFixture, type TlsFixture } from "./support/tls_fixture.ts";

let fixture: TlsFixture | null = null;
let server: ReturnType<typeof startServer> | null = null;

beforeAll(async () => {
  fixture = await createTlsFixture("localhost");
  if (fixture === null) return;
  server = startServer({
    port: 0,
    hostname: "127.0.0.1",
    tls: {
      cert: Bun.file(fixture.certPath),
      key: Bun.file(fixture.keyPath),
      // Bun.serve takes a comma-separated string, not a Node-style array.
      ALPNProtocols: "http/1.1",
    },
  });
});

afterAll(() => {
  server?.stop(true);
  fixture?.cleanup();
});

test("serves HTTPS routes with the configured certificate and ALPN", async () => {
  if (fixture === null || server === null) return; // openssl unavailable

  const response = await fetch(`https://127.0.0.1:${server.port}/healthz`, {
    tls: {
      ca: Bun.file(fixture.caPath),
      serverName: "localhost",
    },
  });

  expect(response.status).toBe(200);
  expect(await response.text()).toBe("ok\n");
});
