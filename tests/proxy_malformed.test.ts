import { test, expect } from "bun:test";

test("fetch rejects with Malformed_HTTP_Response on bad CONNECT reply", async () => {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket) {
        // Malformed CONNECT response (not valid HTTP)
        socket.write("THIS IS NOT HTTP\r\n\r\n");
        socket.end();
      },
      open(socket) {
        socket.data = {};
      },
    },
  });

  const proxyUrl = `http://127.0.0.1:${server.port}`;
  let err: any;
  try {
    await fetch("https://example.com/", { proxy: proxyUrl });
  } catch (e) {
    err = e;
  } finally {
    server.stop(true);
  }

  console.log("caught:", err?.name, err?.code, err?.message);
  expect(err).toBeTruthy();
  // Bun surfaces this as Malformed_HTTP_Response (message or code)
  const text = String(err?.message ?? err?.code ?? err);
  expect(text).toMatch(/Malformed|malformed|proxy/i);
});