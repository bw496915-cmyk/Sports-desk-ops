/**
 * @file lib/token_watch_integration.ts
 * @description Startable token-watch v1.4.4 pipeline: hook-driven theme sync, avatar hydration and
 * WebSocket preview backpressure wired into one lifecycle.
 *
 * The pieces are deliberately small and independently tested; this module only composes them:
 * - theme writes go through deterministic SQLite UDFs and hook-driven sync (`token_watch_theme_store`);
 * - avatar hydration uses the verified simple glob + `.test.png` filter and a lazy Image terminal
 *   chain (`token_watch_avatars`);
 * - preview sockets are paused on `send() === -1`, resumed on `drain`, and torn down with 1011
 *   (`token_watch_preview`);
 * - the compiled binary hardening lives in `scripts/build_token_watch.ts`.
 *
 * `close()` is idempotent and stops the hooks before closing the database: assigning update hooks
 * on a closed `Database` throws, and an in-flight sync must be awaited rather than racing the close.
 */
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { AutomatedDualTokenStore } from "./token_automation.ts";
import { encodeAvatarBase64, listAvatarFiles } from "./token_watch_avatars.ts";
import type { SyncState, SyncTargets } from "./token_watch_daemon.ts";
import {
  createPreviewHub,
  PREVIEW_CLOSE_FAILURE,
  type PreviewHub,
} from "./token_watch_preview.ts";
import {
  attachThemeSyncHooks,
  registerColorUdfs,
  type ThemeSyncController,
} from "./token_watch_theme_store.ts";

/** A hydratable avatar basename: no directories, no test renders. */
const AVATAR_FILE_RE = /^[A-Za-z0-9._-]+\.png$/;

export interface TokenWatchIntegrationOptions {
  /** SQLite path; `":memory:"` by default. */
  readonly dbPath?: string | undefined;
  /** Directory scanned by {@link TokenWatchIntegration.listAvatars}. */
  readonly avatarsDir: string;
  /** `.env`, `.env.example` and `index.theme.gen.ts` destinations. */
  readonly targets: SyncTargets;
  /** Resume an existing sync state, e.g. after a daemon restart. */
  readonly state?: Partial<SyncState> | undefined;
}

export interface TokenWatchIntegration {
  readonly store: AutomatedDualTokenStore;
  readonly db: Database;
  readonly preview: PreviewHub;
  readonly sync: ThemeSyncController;
  listAvatars(): Promise<string[]>;
  encodeAvatar(file: string, cols: number, rows: number): Promise<string>;
  close(): Promise<void>;
}

function assertAvatarFile(file: string): void {
  if (file.endsWith(".test.png") || !AVATAR_FILE_RE.test(file)) {
    throw new TypeError(
      `ERR_TOKEN_WATCH_AVATAR: ${JSON.stringify(file)} is not a hydratable avatar`,
    );
  }
}

/**
 * Open the store, register the colour UDFs, attach serialized sync hooks, and expose the preview
 * hub. The returned pipeline owns the database and the hooks: call {@link
 * TokenWatchIntegration.close} exactly once when done (additional calls are no-ops).
 */
export function startTokenWatchIntegration(
  options: TokenWatchIntegrationOptions,
): TokenWatchIntegration {
  const store = new AutomatedDualTokenStore(options.dbPath ?? ":memory:");
  const db = store.database;
  registerColorUdfs(db);

  const state: SyncState = {
    lastDataVersion: options.state?.lastDataVersion ?? -1,
    lastFingerprint: options.state?.lastFingerprint ?? "",
  };
  const sync = attachThemeSyncHooks(db, state, options.targets);
  const preview = createPreviewHub();
  let closing: Promise<void> | null = null;

  return {
    store,
    db,
    preview,
    sync,
    async listAvatars(): Promise<string[]> {
      return await listAvatarFiles(options.avatarsDir);
    },
    async encodeAvatar(
      file: string,
      cols: number,
      rows: number,
    ): Promise<string> {
      assertAvatarFile(file);
      return await encodeAvatarBase64(join(options.avatarsDir, file), {
        cols,
        rows,
      });
    },
    close(): Promise<void> {
      closing ??= (async () => {
        // Detach first so a write racing the close cannot start a new run; then let the in-flight
        // run (if any) finish. Teardown must happen even when that run failed: otherwise a
        // rejected sync leaks the database and the preview sockets, and the cached promise would
        // make the failed close unrepeatable.
        sync.stop();
        let syncError: unknown;
        try {
          await sync.idle();
        } catch (error) {
          syncError = error;
        }
        preview.closeAll(PREVIEW_CLOSE_FAILURE);
        store.close();
        if (syncError !== undefined) throw syncError;
      })();
      return closing;
    },
  };
}
