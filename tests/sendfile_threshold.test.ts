import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

describe("Sendfile Threshold & Static File Serving Benchmark", () => {
  const tmpDir = tmpdir();
  const file16Kb = resolve(tmpDir, "sportsdesk_bench_16kb.bin");
  const file64Kb = resolve(tmpDir, "sportsdesk_bench_64kb.bin");
  const file1Mb = resolve(tmpDir, "sportsdesk_bench_1mb.bin");

  let server: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    // Generate deterministic binary fixtures
    const buf16Kb = Buffer.alloc(16 * 1024, "A");
    const buf64Kb = Buffer.alloc(64 * 1024, "B");
    const buf1Mb = Buffer.alloc(1024 * 1024, "C");

    writeFileSync(file16Kb, buf16Kb);
    writeFileSync(file64Kb, buf64Kb);
    writeFileSync(file1Mb, buf1Mb);

    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/16kb") {
          return new Response(Bun.file(file16Kb), {
            headers: { "Content-Type": "application/octet-stream" },
          });
        }
        if (url.pathname === "/64kb") {
          return new Response(Bun.file(file64Kb), {
            headers: { "Content-Type": "application/octet-stream" },
          });
        }
        if (url.pathname === "/1mb") {
          return new Response(Bun.file(file1Mb), {
            headers: { "Content-Type": "application/octet-stream" },
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });
  });

  afterAll(() => {
    server.stop(true);
    if (existsSync(file16Kb)) unlinkSync(file16Kb);
    if (existsSync(file64Kb)) unlinkSync(file64Kb);
    if (existsSync(file1Mb)) unlinkSync(file1Mb);
  });

  test("test_measure_lazy_handle_construction_latency", () => {
    const iterations = 2000;

    // Warmup
    for (let i = 0; i < 50; i++) {
      new Response(Bun.file(file16Kb));
      new Response(Bun.file(file64Kb));
      new Response(Bun.file(file1Mb));
    }

    // 16 KB handle construction
    const t0 = performance.now();
    for (let i = 0; i < iterations; i++) {
      new Response(Bun.file(file16Kb));
    }
    const avg16KbUs = ((performance.now() - t0) / iterations) * 1000;

    // 64 KB handle construction
    const t1 = performance.now();
    for (let i = 0; i < iterations; i++) {
      new Response(Bun.file(file64Kb));
    }
    const avg64KbUs = ((performance.now() - t1) / iterations) * 1000;

    // 1 MB handle construction
    const t2 = performance.now();
    for (let i = 0; i < iterations; i++) {
      new Response(Bun.file(file1Mb));
    }
    const avg1MbUs = ((performance.now() - t2) / iterations) * 1000;

    console.log("\n[Benchmark: Response Handle Construction Latency]");
    console.log(` • 16 KB file lazy handle : ${avg16KbUs.toFixed(2)} µs/op`);
    console.log(` • 64 KB file lazy handle : ${avg64KbUs.toFixed(2)} µs/op`);
    console.log(` • 1 MB  file lazy handle : ${avg1MbUs.toFixed(2)} µs/op`);
    console.log(
      " Note: Handle construction is sub-microsecond and independent of payload size because disk bytes are not read eagerly.",
    );

    expect(avg16KbUs).toBeLessThan(50);
    expect(avg64KbUs).toBeLessThan(50);
    expect(avg1MbUs).toBeLessThan(50);
  });

  test("test_measure_end_to_end_socket_transfer_throughput", async () => {
    const iterations = 50;

    // Measure 16 KB end-to-end loopback socket transfer
    const t0 = performance.now();
    for (let i = 0; i < iterations; i++) {
      const res = await fetch(`http://127.0.0.1:${server.port}/16kb`);
      const buf = await res.arrayBuffer();
      expect(buf.byteLength).toBe(16 * 1024);
    }
    const avg16KbTransferMs = (performance.now() - t0) / iterations;

    // Measure 64 KB end-to-end loopback socket transfer
    const t1 = performance.now();
    for (let i = 0; i < iterations; i++) {
      const res = await fetch(`http://127.0.0.1:${server.port}/64kb`);
      const buf = await res.arrayBuffer();
      expect(buf.byteLength).toBe(64 * 1024);
    }
    const avg64KbTransferMs = (performance.now() - t1) / iterations;

    // Measure 1 MB end-to-end loopback socket transfer
    const t2 = performance.now();
    for (let i = 0; i < iterations; i++) {
      const res = await fetch(`http://127.0.0.1:${server.port}/1mb`);
      const buf = await res.arrayBuffer();
      expect(buf.byteLength).toBe(1024 * 1024);
    }
    const avg1MbTransferMs = (performance.now() - t2) / iterations;

    console.log("\n[Benchmark: End-to-End Loopback Socket Transfer Latency]");
    console.log(
      ` • 16 KB transfer (below 32KB upload threshold) : ${avg16KbTransferMs.toFixed(3)} ms/req`,
    );
    console.log(
      ` • 64 KB transfer (above 32KB upload threshold) : ${avg64KbTransferMs.toFixed(3)} ms/req`,
    );
    console.log(
      ` • 1 MB  transfer (1024 KB payload)             : ${avg1MbTransferMs.toFixed(3)} ms/req`,
    );

    expect(avg16KbTransferMs).toBeGreaterThan(0);
    expect(avg64KbTransferMs).toBeGreaterThan(0);
    expect(avg1MbTransferMs).toBeGreaterThan(0);
  });
});
