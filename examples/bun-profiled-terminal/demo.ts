#!/usr/bin/env bun
/**
 * @file examples/bun-profiled-terminal/demo.ts
 * @description End-to-end profiled terminal demo: SQLite profiles, live change watching,
 * clone/diff, host console synchronization, and a PTY session that inherits the profile env.
 *
 * Run from the worktree root:
 *   bun run examples/bun-profiled-terminal/demo.ts
 *
 * The SQLite file lands in `scratch/` (gitignored) and is removed afterwards.
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  NamedColorTokenStore,
  applyProfileToHost,
  probePtySupport,
  resolveTerminalProfile,
  runProfiledPtySession,
} from "./bun-profiled-terminal.ts";

const databasePath =
  Bun.env.PTY_PROFILE_DB ??
  join(import.meta.dir, "../../scratch/pty-profiles-demo.sqlite");

for (const suffix of ["", "-wal", "-shm"]) {
  await rm(`${databasePath}${suffix}`, { force: true });
}

const store = new NamedColorTokenStore(databasePath);

try {
  // -------------------------------------------------------------------------
  // 1. Persist named colors + inspect settings in SQLite.
  // -------------------------------------------------------------------------
  store.setProfile(
    "deep-forensics",
    { accent: "red", warn: "gold", info: "coral", code: "peachpuff" },
    {
      consoleDepth: 5,
      sorted: true,
      compact: false,
      maxArrayLength: 250,
      maxStringLength: 500,
    },
  );

  const profile = resolveTerminalProfile({ profile: "deep-forensics", store });
  console.log(
    `[profile] ${profile.profile} depth=${profile.depth} consoleDepth=${profile.consoleDepth} warnings=${profile.warnings.length}`,
  );

  // -------------------------------------------------------------------------
  // 2. Watch committed mutations, then clone and diff profiles.
  // -------------------------------------------------------------------------
  const changes: string[] = [];
  const stopWatching = store.watchProfile((changedProfile) => {
    changes.push(changedProfile);
  });
  store.setConsoleDepth("deep-forensics", 6);
  store.setToken("deep-forensics", "accent", "orange");
  stopWatching();
  console.log(`[watch] ${changes.length} notifications: ${changes.join(", ")}`);

  // Post-unsubscribe writes still persist, they just do not notify the removed listener.
  store.setConsoleDepth("deep-forensics", 5);
  store.setToken("deep-forensics", "accent", "red");

  store.cloneProfile("deep-forensics", "deep-forensics-copy");
  console.log(
    `[clone] deep-forensics -> deep-forensics-copy; accent=${store.getTokenName("deep-forensics-copy", "accent")}`,
  );
  console.log(`[profiles] ${store.listProfiles().join(", ")}`);

  // -------------------------------------------------------------------------
  // 3. Render the profile card and a diff table through Bun.markdown.ansi.
  // -------------------------------------------------------------------------
  console.log(profile.renderProfileCard());
  console.log(
    profile.renderMarkdown(store.diffProfiles("default", "deep-forensics")),
  );

  // -------------------------------------------------------------------------
  // 4. Sync native console.log()/Bun.inspect() with the profile, then restore.
  // -------------------------------------------------------------------------
  const nested = {
    l1: {
      l2: {
        l3: { l4: { l5: { l6: { l7: "only visible past consoleDepth" } } } },
      },
    },
  };
  {
    using _host = applyProfileToHost(profile);
    console.log(
      `[host] during applyProfileToHost (consoleDepth=${profile.consoleDepth}):`,
    );
    console.log(nested);
  }
  console.log("[host] after dispose (bunfig/native depth restored):");
  console.log(nested);

  // -------------------------------------------------------------------------
  // 5. Run a PTY session whose child inherits PTY_* and BUN_OPTIONS.
  // -------------------------------------------------------------------------
  const pty = probePtySupport();
  if (!pty.available) {
    console.log(
      `[pty] skipped: ${pty.error ?? "PTY unavailable"} (the module still type-renders and persists profiles)`,
    );
  } else {
    const childScript = [
      'console.log("child profile:", process.env.PTY_PROFILE, "accent:", process.env.PTY_ACCENT);',
      'console.log("child depth:", process.env.PTY_CONSOLE_DEPTH, "BUN_OPTIONS:", process.env.BUN_OPTIONS);',
      'console.log({ l1: { l2: { l3: { l4: { l5: { l6: { l7: "expanded" } } } } } } });',
    ].join("\n");

    const result = await runProfiledPtySession({
      profile,
      cmd: ["bun", "-e", childScript],
      env: { BUN_OPTIONS: "" },
      interactive: false,
      captureOutput: true,
    });
    console.log(
      `[pty] exit=${result.exitCode} signal=${result.signal} timedOut=${result.timedOut} truncated=${result.captureTruncated}`,
    );
    console.log(result.cleanOutput.trimEnd());
  }
} finally {
  store.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    await rm(`${databasePath}${suffix}`, { force: true });
  }
}
