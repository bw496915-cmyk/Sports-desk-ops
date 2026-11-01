/**
 * Bun.Terminal test title SSOT.
 *
 * Pattern: `{layer} · {surface} · {action} · expects {outcome}`
 * - layer: terminal.pty | terminal.meta | terminal.util
 * - surface: blog.bash | blog.vim | blog.htop | spawn | driveBashScript
 */

export const BUN_TERMINAL_PTY_TEST_NAME = {
  meta: {
    v14BlogUrlAndSpawnSnippetPinned:
      "terminal.meta · constants · BUN_TERMINAL_V14_BLOG_URL and spawn snippet · expects pinned bun.sh anchor and Hello from PTY in example",
    v14BlogCapabilitiesShipNote:
      "terminal.meta · constants · BUN_TERMINAL_V14_BLOG_CAPABILITIES ship note · expects write resize colored output platforms and PR ids 25415 29522",
  },
  util: {
    stripAnsiSgr:
      "terminal.util · stripPtyCapture · red SGR wrapped hi · expects plain hi without escape codes",
  },
  spawn: {
    childReportsIsTty:
      "terminal.pty · spawn · bun -e isTTY probe · expects exit 0 and stdout true",
    driveBashEchoCapture:
      "terminal.pty · driveBashScript · echo pty-helper then exit · expects exit 0 and stdout contains pty-helper",
    terminalWriteResizeColored:
      "terminal.pty · spawn.terminal · write + resize(100x30) + bash printf SGR red · expects COLUMNS/LINES after resize and raw capture contains ESC[31m",
  },
  blog: {
    bashLcEcho:
      "terminal.pty · blog.bash · spawn(-lc) echo Hello from bash PTY · expects exit 0 and stdout contains greeting",
    bashTerminalWriteScript:
      "terminal.pty · blog.bash · driveBashScript terminal.write echo scripted-input · expects exit 0 and stdout contains scripted-input",
    vimBatchQuit:
      "terminal.pty · blog.vim · spawn(-N -u NONE -n -c qa!) · expects exit 0 without hang",
    vimIsattyStdout:
      "terminal.pty · blog.vim · -c echo isatty(1) then qa! · expects exit 0 and stdout shows TTY (1 or true)",
    htopTuiFooterThenKill:
      "terminal.pty · blog.htop · spawnInPtyUntil F1Help|F10Quit · expects rawBytes>100, footer in capture, killed true",
  },
} as const;
