import { describe, expect, test } from "bun:test";
import {
  flagValue,
  hasFlag,
  parseCliArgs,
  wantsHelp,
} from "../lib/cli_args.ts";

const VALUE_FLAGS = ["--ops", "--body", "--prefix"];

describe("cli args", () => {
  test("separates values, switches and positionals", () => {
    const args = parseCliArgs(
      ["--ops", "Pending,getGrading", "--dry-run", "file.md"],
      {
        valueFlags: VALUE_FLAGS,
      },
    );
    expect(flagValue(args, "--ops", "")).toBe("Pending,getGrading");
    expect(hasFlag(args, "--dry-run")).toBe(true);
    expect(args.positionals).toEqual(["file.md"]);
  });

  test("supports --name=value, including values with =", () => {
    const args = parseCliArgs(["--body=a=1&b=2", "--prefix=/cloud/api/Report"]);
    expect(flagValue(args, "--body", "")).toBe("a=1&b=2");
    expect(flagValue(args, "--prefix", "")).toBe("/cloud/api/Report");
  });

  test("a switch followed by another flag does not swallow it", () => {
    const args = parseCliArgs(["--dry-run", "--ops", "Pending"], {
      valueFlags: VALUE_FLAGS,
    });
    expect(hasFlag(args, "--dry-run")).toBe(true);
    expect(flagValue(args, "--ops", "")).toBe("Pending");
  });

  test("a declared value flag consumes the next token even without a leading dash", () => {
    const args = parseCliArgs(["--ops", "Pending"], {
      valueFlags: VALUE_FLAGS,
    });
    expect(flagValue(args, "--ops", "")).toBe("Pending");
  });

  test("repeated flags keep the last value and expose all of them", () => {
    const args = parseCliArgs(["--ops", "a", "--ops", "b"], {
      valueFlags: VALUE_FLAGS,
    });
    expect(flagValue(args, "--ops", "")).toBe("b");
    expect(args.values.get("--ops")).toEqual(["a", "b"]);
  });

  test("-- ends flag parsing", () => {
    const args = parseCliArgs(["--dry-run", "--", "--not-a-flag"]);
    expect(args.positionals).toEqual(["--not-a-flag"]);
  });

  test("help is recognised in both spellings", () => {
    expect(wantsHelp(parseCliArgs(["--help"]))).toBe(true);
    expect(wantsHelp(parseCliArgs(["-h"]))).toBe(true);
    expect(wantsHelp(parseCliArgs([]))).toBe(false);
  });

  test("an undeclared flag never consumes the token after it", () => {
    const args = parseCliArgs(["--unknown", "value"]);
    expect(hasFlag(args, "--unknown")).toBe(true);
    expect(args.positionals).toEqual(["value"]);
  });

  test("a declared flag with no following token is a switch", () => {
    const args = parseCliArgs(["--ops"], { valueFlags: VALUE_FLAGS });
    expect(flagValue(args, "--ops", "default")).toBe("default");
    expect(hasFlag(args, "--ops")).toBe(true);
  });
});
