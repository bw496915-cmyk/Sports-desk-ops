/**
 * @file tests/r2_s3_inspect.test.ts
 * @description An R2S3Client must never expose its access key or secret through
 * Bun.inspect (including showHidden) or JSON serialization.
 */

import { expect, test } from "bun:test";

import { R2S3Client } from "../lib/r2_s3_client.ts";

const ACCESS = "AKIA_TEST_ACCESS_KEY";
const SECRET = "SECRET_TEST_ACCESS_VALUE";

function client(): R2S3Client {
  return R2S3Client.fromOptions({
    bucket: "test-bucket",
    endpoint: "https://r2.example.com",
    accessKeyId: ACCESS,
    secretAccessKey: SECRET,
    publicBase: "https://cdn.example.com",
  });
}

test("Bun.inspect redacts R2 credentials, even with showHidden", () => {
  const inspected = Bun.inspect(client(), { depth: 8 });

  expect(inspected).not.toContain(ACCESS);
  expect(inspected).not.toContain(SECRET);
  expect(inspected).toContain("[REDACTED]");
  expect(inspected).toContain("test-bucket");
});

test("JSON serialization redacts R2 credentials", () => {
  const json = JSON.stringify(client());

  expect(json).not.toContain(ACCESS);
  expect(json).not.toContain(SECRET);
  expect(JSON.parse(json)).toMatchObject({
    bucket: "test-bucket",
    credentials: "[REDACTED]",
  });
});
