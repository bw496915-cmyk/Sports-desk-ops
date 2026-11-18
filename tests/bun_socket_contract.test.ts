import { expect, test } from "bun:test";

test("write returns -1 on a closed socket", async () => {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  try {
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port: server.port,
      socket: { data() {}, connectError() {} },
    });
    socket.close();
    expect(socket.write("x")).toBe(-1);
  } finally {
    server.stop(true);
  }
});

test("connectError suppresses unhandled rejection; promise still rejects", async () => {
  let called = false;
  await expect(
    Bun.connect({
      hostname: "127.0.0.1",
      port: 1,
      socket: {
        data() {},
        connectError(_socket, _error) {
          called = true;
        },
      },
    }),
  ).rejects.toBeDefined();
  expect(called).toBe(true);
});

test("binaryType uint8array delivers Uint8Array to the data handler", async () => {
  let resolveData!: (data: unknown) => void;
  const received = new Promise<unknown>((resolve) => {
    resolveData = resolve;
  });
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      binaryType: "uint8array",
      data(_socket, data) {
        resolveData(data);
      },
    },
  });
  const client = await Bun.connect({
    hostname: "127.0.0.1",
    port: server.port,
    socket: { data() {} },
  });
  try {
    client.write(new Uint8Array([1, 2, 3]));
    const data = await Promise.race([
      received,
      Bun.sleep(1_000).then(() => {
        throw new Error("no socket data within 1s");
      }),
    ]);
    expect(data).toBeInstanceOf(Uint8Array);
  } finally {
    client.close();
    server.stop(true);
  }
});
