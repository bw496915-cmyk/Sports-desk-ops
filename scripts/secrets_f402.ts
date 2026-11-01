#!/usr/bin/env bun
/**
 * @file scripts/secrets_f402.ts
 * @description Keep the F402 credentials in the OS credential store instead of `.env`.
 *
 * Values are never printed and never accepted on argv. `set` reads the password from stdin, so it
 * composes with a password manager: `op read ... | bun run secrets:f402 set --agent-id 118`.
 */

import {
  flagValue,
  parseCliArgs,
  printHelp,
  wantsHelp,
} from "../lib/cli_args.ts";
import { SECRET_NAMES, SECRETS_SERVICE } from "./capture/f402_login.ts";

const HELP = `
secrets:f402 — store the F402 credentials in the OS credential store

Usage:
  bun run secrets:f402 status
  <password-source> | bun run secrets:f402 set --agent-id <id>
  bun run secrets:f402 delete

Options:
  --agent-id <id>   Manager agent id (not secret)
  -h, --help        This text

Examples:
  bun run secrets:f402 status
  printf '%s\\n' "$F402_PASSWORD" | bun run secrets:f402 set --agent-id 118
  op read "op://Private/f402/password" | bun run secrets:f402 set --agent-id 118
  bun run secrets:f402 delete

env F402_AGENT_ID / F402_PASSWORD still win over the store, so a one-off override never touches it.
`.trim();

async function readLine(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(new TextDecoder().decode(chunk));
    if (chunks.join("").includes("\n")) break;
  }
  return chunks.join("").split("\n")[0]?.trim() ?? "";
}

const parsed = parseCliArgs(process.argv.slice(2), {
  valueFlags: ["--agent-id"],
});
if (wantsHelp(parsed)) {
  printHelp(HELP);
  process.exit(0);
}

const command = parsed.positionals[0] ?? "status";

switch (command) {
  case "status": {
    const agentId = await Bun.secrets.get({
      service: SECRETS_SERVICE,
      name: SECRET_NAMES.agentId,
    });
    const password = await Bun.secrets.get({
      service: SECRETS_SERVICE,
      name: SECRET_NAMES.password,
    });
    console.log(`service: ${SECRETS_SERVICE}`);
    console.log(`agent id: ${agentId === null ? "absent" : "stored"}`);
    console.log(`password: ${password === null ? "absent" : "stored"}`);
    if (agentId === null || password === null) {
      console.error(
        "  printf '%s\\n' \"$F402_PASSWORD\" | bun run secrets:f402 set --agent-id <id>",
      );
    }
    break;
  }
  case "set": {
    const agentId = flagValue(parsed, "--agent-id", "");
    if (agentId === "") {
      console.error("secrets:f402: --agent-id is required.");
      console.error(
        "  printf '%s\\n' \"$F402_PASSWORD\" | bun run secrets:f402 set --agent-id <id>",
      );
      process.exit(2);
    }
    if (process.stdin.isTTY) {
      console.error(
        "secrets:f402: pipe the password on stdin; it is not accepted on argv.",
      );
      console.error(
        "  printf '%s\\n' \"$F402_PASSWORD\" | bun run secrets:f402 set --agent-id <id>",
      );
      process.exit(2);
    }
    const password = await readLine();
    if (password === "") {
      console.error("secrets:f402: stdin was empty; nothing stored.");
      console.error(
        "  printf '%s\\n' \"$F402_PASSWORD\" | bun run secrets:f402 set --agent-id <id>",
      );
      process.exit(2);
    }
    await Bun.secrets.set({
      service: SECRETS_SERVICE,
      name: SECRET_NAMES.agentId,
      value: agentId,
    });
    await Bun.secrets.set({
      service: SECRETS_SERVICE,
      name: SECRET_NAMES.password,
      value: password,
    });
    console.error(
      `secrets:f402: stored agent id and password under service ${SECRETS_SERVICE}`,
    );
    break;
  }
  case "delete": {
    await Bun.secrets.delete({
      service: SECRETS_SERVICE,
      name: SECRET_NAMES.agentId,
    });
    await Bun.secrets.delete({
      service: SECRETS_SERVICE,
      name: SECRET_NAMES.password,
    });
    console.error(`secrets:f402: removed the ${SECRETS_SERVICE} credentials`);
    break;
  }
  default: {
    console.error(
      `secrets:f402: unknown command "${command}" (status|set|delete).`,
    );
    console.error("  bun run secrets:f402 status");
    process.exit(2);
  }
}
