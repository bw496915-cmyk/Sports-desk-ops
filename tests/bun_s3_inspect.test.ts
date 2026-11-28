/**
 * @file tests/bun_s3_inspect.test.ts
 * @description Pin the security property the seal would otherwise add: Bun's
 * global S3 client must not expose enumerable credential fields, and inspect
 * must render them redacted. A future Bun change that regresses this fails here.
 */

import { expect, test } from "bun:test";

test("Bun.s3 exposes no enumerable credential properties", () => {
  expect(typeof Bun.s3).toBe("object");
  expect(Object.keys(Bun.s3)).toEqual([]);
});

test("Bun.s3 inspect renders credentials redacted when they are present", () => {
  const access = "AKIA_TEST_ACCESS_KEY_123";
  const secret = "SECRET_TEST_ACCESS_VALUE";
  const script = [
    "const out = Bun.inspect(Bun.s3, { showHidden: true, depth: 8 });",
    "console.log(out);",
  ].join("\n");
  const proc = Bun.spawnSync({
    cmd: [process.execPath, "-e", script],
    env: {
      ...process.env,
      AWS_ACCESS_KEY_ID: access,
      AWS_SECRET_ACCESS_KEY: secret,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = proc.stdout.toString();

  expect(proc.exitCode).toBe(0);
  expect(out).toContain('accessKeyId: "[REDACTED]"');
  expect(out).toContain('secretAccessKey: "[REDACTED]"');
  expect(out).not.toContain(access);
  expect(out).not.toContain(secret);
});
