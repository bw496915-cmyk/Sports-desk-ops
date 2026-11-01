#!/usr/bin/env bun
/**
 * @file scripts/secrets_f402.ts
 * @description Keep the F402 credentials in the OS credential store instead of `.env`.
 *
 *   bun run secrets:f402 status
 *   printf '%s\n' "$F402_PASSWORD" | bun run secrets:f402 set --agent-id 118
 *   bun run secrets:f402 delete
 *
 * Values are never printed and never accepted on argv except the agent id, which is not a secret.
 */

import { SECRET_NAMES, SECRETS_SERVICE } from "./capture/f402_login.ts";

const args = process.argv.slice(2);
const command = args[0] ?? "status";

function flag(name: string): string {
  const index = args.indexOf(name);
  return index !== -1 && index + 1 < args.length ? args[index + 1]! : "";
}

async function readLine(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(new TextDecoder().decode(chunk));
    if (chunks.join("").includes("\n")) break;
  }
  return chunks.join("").split("\n")[0]?.trim() ?? "";
}

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
    console.log(`agent id: ${agentId === null ? "absent" : "stored"}`);
    console.log(`password: ${password === null ? "absent" : "stored"}`);
    break;
  }
  case "set": {
    const agentId = flag("--agent-id");
    if (agentId === "") {
      console.error("secrets:f402: --agent-id is required");
      process.exit(2);
    }
    const password = process.stdin.isTTY ? "" : await readLine();
    if (password === "") {
      console.error(
        "secrets:f402: pipe the password on stdin (it is not accepted on argv)",
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
      `secrets:f402: unknown command ${command} (status|set|delete)`,
    );
    process.exit(2);
  }
}
