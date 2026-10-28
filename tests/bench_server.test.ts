import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Server Latency & Throughput Benchmark", () => {
  test("bench_response_json_vs_manual_stringify", () => {
    const payload = {
      status: "healthy",
      port: 4020,
      runtime: "Bun v1.4.4",
      accounts: Array.from({ length: 25 }, (_, i) => ({
        id: `ACC_${i}`,
        val: i * 100,
        active: i % 2 === 0,
      })),
    };
    const iterations = 5000;

    // Warmup
    for (let i = 0; i < 200; i++) {
      Response.json(payload);
      new Response(JSON.stringify(payload), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // 1. Manual Path: JSON.stringify + new Response
    const t0 = performance.now();
    for (let i = 0; i < iterations; i++) {
      new Response(JSON.stringify(payload), {
        headers: { "Content-Type": "application/json" },
      });
    }
    const manualMs = performance.now() - t0;
    const manualAvgUs = (manualMs / iterations) * 1000;

    // 2. Native Path: Response.json()
    const t1 = performance.now();
    for (let i = 0; i < iterations; i++) {
      Response.json(payload);
    }
    const nativeMs = performance.now() - t1;
    const nativeAvgUs = (nativeMs / iterations) * 1000;

    console.log(`\n[Benchmark: JSON Serialization] ${iterations} iterations:`);
    console.log(
      ` • Manual (JSON.stringify + headers) : ${manualMs.toFixed(3)} ms total (${manualAvgUs.toFixed(2)} µs/op)`,
    );
    console.log(
      ` • Native (Response.json)             : ${nativeMs.toFixed(3)} ms total (${nativeAvgUs.toFixed(2)} µs/op)`,
    );
    console.log(
      ` • Relative Ratio                     : ${(manualMs / nativeMs).toFixed(2)}x`,
    );

    expect(nativeMs).toBeGreaterThan(0);
    expect(manualMs).toBeGreaterThan(0);
    expect(nativeAvgUs).toBeLessThan(100); // Expect sub-100µs per operation
  });

  test("bench_bun_file_vs_manual_read_file_sync", () => {
    const filePath = resolve(
      import.meta.dir,
      "../customer-churn-simulation-dashboard.html",
    );
    const fileSizeKb = (readFileSync(filePath).length / 1024).toFixed(1);
    const iterations = 1000;

    // Warmup
    for (let i = 0; i < 50; i++) {
      new Response(Bun.file(filePath));
      new Response(readFileSync(filePath, "utf-8"), {
        headers: { "Content-Type": "text/html" },
      });
    }

    // 1. Manual Path: readFileSync buffer into memory + new Response
    const t0 = performance.now();
    for (let i = 0; i < iterations; i++) {
      const content = readFileSync(filePath, "utf-8");
      new Response(content, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    const manualMs = performance.now() - t0;
    const manualAvgUs = (manualMs / iterations) * 1000;

    // 2. Native Path: Bun.file handle + new Response (lazy / zero-copy kernel transfer)
    const t1 = performance.now();
    for (let i = 0; i < iterations; i++) {
      const file = Bun.file(filePath);
      new Response(file, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    const bunFileMs = performance.now() - t1;
    const bunFileAvgUs = (bunFileMs / iterations) * 1000;
    const speedup = manualMs / bunFileMs;

    console.log(
      `\n[Benchmark: Static HTML Serving] ${iterations} iterations (${fileSizeKb} KB):`,
    );
    console.log(
      ` • Manual (readFileSync + headers)   : ${manualMs.toFixed(3)} ms total (${manualAvgUs.toFixed(2)} µs/op)`,
    );
    console.log(
      ` • Native (Bun.file lazy handle)      : ${bunFileMs.toFixed(3)} ms total (${bunFileAvgUs.toFixed(2)} µs/op)`,
    );
    console.log(
      ` • Handle Creation Speedup            : ${speedup.toFixed(2)}x faster`,
    );

    expect(bunFileMs).toBeGreaterThan(0);
    expect(bunFileAvgUs).toBeLessThan(manualAvgUs);
    expect(speedup).toBeGreaterThan(10); // Native file handle creation is orders of magnitude faster
  });
});
