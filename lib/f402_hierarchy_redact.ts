/** Shared redaction for logs, `Bun.inspect.custom`, and JSON sidecars. */

export const SENSITIVE_KEY =
  /^(pass|password|pwd|secret|token|auth|ssn|dob|card|authorization|cookie)$/i;

export function redactUnknown(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactUnknown(val, seen);
  }
  return out;
}
