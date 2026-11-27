/**
 * SQLite-backed Durable Object (`PpmLiveTicksCollectorDO`) that streams Ganchrow Partner 118 live
 * game ticks anonymously from `wss://pandora.ganchrow.com`, persists `(event_id, ts_ms)` into DO
 * SQLite, auto-unsubscribes settled events, flushes immutable chunks to R2 via ETag CAS, and
 * serves real-time bet anomaly evaluations.
 *
 * Invariants:
 *  - `blockConcurrencyWhile` is ONLY used in the constructor for synchronous SQLite DDL (never
 *    across `fetch()` or external WebSocket I/O).
 *  - `MonotonicClock.nowNs()` drives heartbeat timeouts, reconnect backoff, and flush intervals;
 *    `WallClock.nowMs()` stamps event `ts_ms` and R2 publish metadata.
 *  - Zero manager credentials: anonymous `partnerId: "118"`, `flavor: "live"`.
 *  - Lazy `crypto.getRandomValues` (only inside runtime methods, never at module scope).
 *
 * @file workers/ppm-live-ticks/src/collector_do.ts
 */

import { DurableObject } from "cloudflare:workers";

import {
  computeReconnectBackoffMs,
  defaultMonotonicClock,
  defaultWallClock,
  elapsedMsFromNs,
  lazyRandomHex,
} from "./clocks.ts";
import {
  flushLineTicksBatchToR2,
  flushTicksBatchToR2,
  type FlushTicksResult,
  type PpmLineTickRecord,
  type PpmTickRecord,
  type PpmTicksTaxonomy,
} from "./r2_cas_flush.ts";
import {
  applyJsonPatchInPlace,
  decodeSpandoraFrame,
  EVENT_DATA_LOCK_RE,
  EVENT_DATA_REMOVE_RE,
  eventDataTopicForFlavor,
  extractLeagueCatalog,
  extractLiveEventsFromEventData,
  extractMarketLinesFromCoefficients,
  extractScoreSnapshot,
  liveCoefficientsTopic,
  PPM_DEFAULT_LINE_SET,
  parseBinaryAttachmentTopic,
  type PpmFeedFlavor,
} from "./spandora_wire.ts";

export type PpmLeagueRow = {
  readonly league_id: number;
  readonly name: string | null;
  readonly slug: string | null;
  readonly updated_at_ms: number;
};

export type PpmEnrichedTickRecord = PpmTickRecord & {
  readonly league_name: string | null;
  readonly league_slug: string | null;
};

export interface BetAnomalyEvaluationInput {
  readonly eventId: number;
  readonly placedMs: number;
  readonly acceptedMs: number;
  readonly snipeThresholdMs?: number;
  readonly stallWindowMs?: number;
}

export interface BetAnomalyEvaluation {
  readonly eventId: number;
  readonly placedMs: number;
  readonly acceptedMs: number;
  readonly ticksInspected: number;
  readonly timeUntilScoreMs: number | null;
  readonly scoreDuringDelay: boolean;
  readonly acceptedWhileBlocked: boolean;
  readonly feedStallAtPlacement: boolean;
  readonly flags: readonly string[];
}

export interface CollectorStatus {
  readonly instanceId: string;
  readonly flavor: PpmFeedFlavor;
  readonly taxonomy: PpmTicksTaxonomy;
  readonly connected: boolean;
  readonly running: boolean;
  readonly leaguesCount: number;
  readonly subscribedEvents: number;
  readonly unsubscribedCount: number;
  readonly textFramesReceived: number;
  readonly binaryFramesReceived: number;
  readonly lastTextFramePrefix: string | null;
  readonly framesReceived: number;
  readonly ticksStoredTotal: number;
  readonly ticksUnflushed: number;
  readonly lineTicksStoredTotal: number;
  readonly lineTicksUnflushed: number;
  readonly closingLinesStoredTotal: number;
  readonly reconnectAttempts: number;
  readonly lastHeartbeatAgeMs: number | null;
  readonly lastTickTsMs: number | null;
  readonly lastFlush: FlushTicksResult | null;
  readonly lastLineFlush: FlushTicksResult | null;
  readonly lastError: string | null;
}

const ALARM_INTERVAL_MS = 15_000;
const HEARTBEAT_STALE_MS = 45_000;
const MAX_FLUSH_BATCH = 2_000;

interface ScoreState {
  home: number | null;
  away: number | null;
  isBlocked: boolean;
  sportId: number;
  leagueId: number;
}

export class PpmLiveTicksCollectorDO extends DurableObject<Env> {
  private instanceId: string | null = null;
  private flavor: PpmFeedFlavor = "live";
  private ws: WebSocket | null = null;
  private running = false;
  private connected = false;
  private pendingBinaryTopic: string | null = null;
  private eventDataDoc: Record<string, unknown> = {};
  private coeffDocs = new Map<number, Record<string, unknown>>();
  private lastLineSignature = new Map<string, string>();
  private subscribedIds = new Set<number>();
  private eventState = new Map<number, ScoreState>();

  // Monotonic timers (`bigint` nanoseconds) — never mixed with wall-clock `Date.now()`!
  private lastHeartbeatNs: bigint | null = null;
  private lastFlushNs: bigint | null = null;
  private nextReconnectAfterNs: bigint | null = null;

  private textFramesReceived = 0;
  private binaryFramesReceived = 0;
  private lastTextFramePrefix: string | null = null;
  private framesReceived = 0;
  private unsubscribedCount = 0;
  private reconnectAttempts = 0;
  private lastFlush: FlushTicksResult | null = null;
  private lastLineFlush: FlushTicksResult | null = null;
  private lastError: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS ppm_live_ticks (
          event_id INTEGER NOT NULL,
          ts_ms INTEGER NOT NULL,
          sport_id INTEGER NOT NULL DEFAULT 0,
          league_id INTEGER NOT NULL DEFAULT 0,
          home_score INTEGER,
          away_score INTEGER,
          period INTEGER,
          clock_sec INTEGER,
          is_blocked INTEGER NOT NULL DEFAULT 0,
          score_changed INTEGER NOT NULL DEFAULT 0,
          source_topic TEXT NOT NULL,
          raw_sha256 TEXT NOT NULL,
          flushed INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (event_id, ts_ms)
        );
        CREATE INDEX IF NOT EXISTS idx_ppm_live_ticks_flushed
          ON ppm_live_ticks (flushed, ts_ms);
        CREATE INDEX IF NOT EXISTS idx_ppm_live_ticks_ts
          ON ppm_live_ticks (ts_ms);
        CREATE TABLE IF NOT EXISTS ppm_line_ticks (
          event_id INTEGER NOT NULL,
          ts_ms INTEGER NOT NULL,
          line_set TEXT NOT NULL,
          flavor TEXT NOT NULL,
          sport_id INTEGER NOT NULL DEFAULT 0,
          league_id INTEGER NOT NULL DEFAULT 0,
          market_id INTEGER NOT NULL,
          market_kind TEXT NOT NULL,
          period_kind TEXT NOT NULL,
          line REAL,
          odds_a REAL,
          odds_b REAL,
          is_closing INTEGER NOT NULL DEFAULT 0,
          source_topic TEXT NOT NULL,
          raw_sha256 TEXT NOT NULL,
          flushed INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (event_id, market_id, period_kind, ts_ms, is_closing)
        );
        CREATE INDEX IF NOT EXISTS idx_ppm_line_ticks_lookup
          ON ppm_line_ticks (event_id, market_kind, period_kind, ts_ms);
        CREATE INDEX IF NOT EXISTS idx_ppm_line_ticks_flushed
          ON ppm_line_ticks (flushed, ts_ms);
        CREATE TABLE IF NOT EXISTS ppm_leagues (
          league_id INTEGER PRIMARY KEY,
          name TEXT,
          slug TEXT,
          updated_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS collector_meta (
          k TEXT PRIMARY KEY,
          v TEXT NOT NULL
        );
      `);
      const storedFlavor = this.ctx.storage.sql
        .exec<{ v: string }>("SELECT v FROM collector_meta WHERE k = 'flavor'")
        .toArray()[0]?.v;
      if (storedFlavor === "prematch" || storedFlavor === "live") {
        this.flavor = storedFlavor;
      }
    });
  }

  private getInstanceId(): string {
    if (this.instanceId === null) {
      // Lazy Web Crypto generation — never executed at module scope.
      this.instanceId = `do-${lazyRandomHex(6)}`;
    }
    return this.instanceId;
  }

  private getTaxonomy(): PpmTicksTaxonomy {
    const partnerId = Number(this.env.PARTNER_ID || "118");
    return {
      office: "buckeye",
      supplier: "ganchrow",
      partnerId: Number.isFinite(partnerId) ? partnerId : 118,
      endpoint: "ppm-live-ticks",
      provenance: "live_api",
    };
  }

  private getLineSet(): string {
    return this.env.PPM_LINE_SET?.trim() || PPM_DEFAULT_LINE_SET;
  }

  private getMaxSubscribedEvents(): number {
    const parsed = Number(this.env.MAX_SUBSCRIBED_EVENTS || "120");
    return Number.isFinite(parsed) && parsed > 0
      ? Math.min(500, Math.trunc(parsed))
      : 120;
  }

  private getFlushIntervalMs(): number {
    const parsed = Number(this.env.FLUSH_INTERVAL_SEC || "60");
    return Number.isFinite(parsed) && parsed >= 10
      ? Math.trunc(parsed) * 1_000
      : 60_000;
  }

  private getRetentionMs(): number {
    const parsed = Number(this.env.RETENTION_HOURS || "24");
    const hours =
      Number.isFinite(parsed) && parsed >= 1 ? Math.min(168, parsed) : 24;
    return Math.trunc(hours * 3_600_000);
  }

  private logStructured(
    level: "info" | "error",
    message: string,
    extra: Record<string, unknown> = {},
  ): void {
    const payload = JSON.stringify({
      service: "ppm-live-ticks",
      instanceId: this.getInstanceId(),
      message,
      ts: new Date(defaultWallClock.nowMs()).toISOString(),
      ...extra,
    });
    if (level === "error") {
      console.error(payload);
    } else {
      console.log(payload);
    }
  }

  /** Start or maintain the outbound Pandora Socket.IO collector and schedule the alarm watchdog. */
  async ensureRunning(flavor?: PpmFeedFlavor): Promise<CollectorStatus> {
    if (flavor && flavor !== this.flavor) {
      this.flavor = flavor;
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO collector_meta (k, v) VALUES ('flavor', ?)",
        flavor,
      );
    }
    this.running = true;
    await this.connectIfNeeded();
    await this.scheduleNextAlarm();
    return this.getStatus();
  }

  /** Gracefully stop the outbound WebSocket collector (does not drop stored SQLite ticks). */
  async stopCollector(): Promise<CollectorStatus> {
    this.running = false;
    this.closeSocket("operator_stop");
    await this.ctx.storage.deleteAlarm();
    return this.getStatus();
  }

  /** Force DO isolate eviction so the next request boots cleanly on the latest deployed version. */
  async resetIsolate(): Promise<void> {
    this.running = false;
    this.closeSocket("operator_reset");
    await this.ctx.storage.deleteAlarm();
    this.ctx.abort("operator_reset");
  }

  /** Alarm watchdog: verifies WebSocket liveness (monotonic), flushes R2 CAS batches, prunes old ticks. */
  async alarm(): Promise<void> {
    if (!this.running) return;
    const nowNs = defaultMonotonicClock.nowNs();

    if (
      this.connected &&
      this.lastHeartbeatNs !== null &&
      elapsedMsFromNs(this.lastHeartbeatNs, nowNs) > HEARTBEAT_STALE_MS
    ) {
      this.logStructured(
        "error",
        "pandora heartbeat stale; forcing reconnect",
        {
          staleMs: Math.round(elapsedMsFromNs(this.lastHeartbeatNs, nowNs)),
        },
      );
      this.closeSocket("heartbeat_stale");
    }

    if (!this.connected) {
      if (
        this.nextReconnectAfterNs === null ||
        nowNs >= this.nextReconnectAfterNs
      ) {
        await this.connectIfNeeded();
      }
    }

    const flushDue =
      this.lastFlushNs === null ||
      elapsedMsFromNs(this.lastFlushNs, nowNs) >= this.getFlushIntervalMs();
    if (flushDue) {
      try {
        await this.flushNow();
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        this.logStructured("error", "r2 cas flush failed", {
          error: this.lastError,
        });
      }
    }

    this.pruneExpiredTicks();
    await this.scheduleNextAlarm();
  }

  private async scheduleNextAlarm(): Promise<void> {
    await this.ctx.storage.setAlarm(
      defaultWallClock.nowMs() + ALARM_INTERVAL_MS,
    );
  }

  private closeSocket(reason: string): void {
    const sock = this.ws;
    this.ws = null;
    this.connected = false;
    this.pendingBinaryTopic = null;
    if (sock) {
      try {
        sock.close(1000, reason);
      } catch {
        // ignore close race
      }
    }
  }

  private async connectIfNeeded(): Promise<void> {
    if (this.connected && this.ws !== null) return;
    const rawUrl =
      this.env.PPM_FEED_URL?.trim() ||
      "wss://pandora.ganchrow.com/socket.io/?EIO=4&transport=websocket";
    const httpUpgradeUrl = rawUrl
      .replace(/^wss:/i, "https:")
      .replace(/^ws:/i, "http:");

    try {
      const resp = await fetch(httpUpgradeUrl, {
        headers: {
          Upgrade: "websocket",
          Origin: "https://ppm.sportswidgets.pro",
        },
      });
      const sock = resp.webSocket;
      if (!sock) {
        throw new Error(`pandora upgrade failed with HTTP ${resp.status}`);
      }
      this.ws = sock;
      this.connected = true;
      this.reconnectAttempts = 0;
      this.nextReconnectAfterNs = null;
      this.lastHeartbeatNs = defaultMonotonicClock.nowNs();
      this.lastError = null;
      this.subscribedIds.clear();
      this.coeffDocs.clear();

      sock.addEventListener("message", (evt: MessageEvent) => {
        this.ctx.waitUntil(
          this.handleWsMessage(evt.data).catch((err) => {
            this.lastError = err instanceof Error ? err.message : String(err);
            this.logStructured("error", "ws message handler failed", {
              error: this.lastError,
            });
          }),
        );
      });
      sock.addEventListener("close", (evt: CloseEvent) => {
        this.handleWsDisconnect(`close:${evt.code}`);
      });
      sock.addEventListener("error", () => {
        this.handleWsDisconnect("socket_error");
      });
      sock.accept();

      this.logStructured("info", "pandora websocket connected", {
        url: rawUrl,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.handleWsDisconnect(message);
    }
  }

  private handleWsDisconnect(reason: string): void {
    this.ws = null;
    this.connected = false;
    this.pendingBinaryTopic = null;
    this.lastError = reason;
    const backoffMs = computeReconnectBackoffMs(this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.nextReconnectAfterNs =
      defaultMonotonicClock.nowNs() + BigInt(backoffMs) * 1_000_000n;
    this.logStructured("error", "pandora websocket disconnected", {
      reason,
      reconnectAttempts: this.reconnectAttempts,
      backoffMs,
    });
  }

  private sendText(payload: string): void {
    if (!this.ws || !this.connected) return;
    try {
      this.ws.send(payload);
    } catch (err) {
      this.handleWsDisconnect(err instanceof Error ? err.message : String(err));
    }
  }

  private async handleWsMessage(data: unknown): Promise<void> {
    this.lastHeartbeatNs = defaultMonotonicClock.nowNs();
    if (typeof data === "string") {
      this.textFramesReceived += 1;
      if (data !== "2") {
        this.lastTextFramePrefix = data.slice(0, 64);
      }
      this.handleTextFrame(data);
      return;
    }
    if (data instanceof ArrayBuffer) {
      this.binaryFramesReceived += 1;
      await this.handleBinaryFrame(new Uint8Array(data));
      return;
    }
    if (ArrayBuffer.isView(data)) {
      this.binaryFramesReceived += 1;
      await this.handleBinaryFrame(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      );
      return;
    }
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      this.binaryFramesReceived += 1;
      await this.handleBinaryFrame(new Uint8Array(await data.arrayBuffer()));
    }
  }

  private handleTextFrame(frame: string): void {
    if (frame === "2") {
      this.sendText("3");
      return;
    }
    if (frame.startsWith("0{")) {
      this.sendText("40");
      return;
    }
    if (frame.startsWith("40")) {
      const partnerId = String(this.getTaxonomy().partnerId);
      this.sendText(
        `42["setSocketMetadata",${JSON.stringify({ partnerId, flavor: this.flavor })}]`,
      );
      return;
    }
    if (frame.includes("socketMetadataSet")) {
      const eventDataTopic = eventDataTopicForFlavor(
        this.getLineSet(),
        this.flavor,
      );
      this.sendText(
        `42["subscribe",${JSON.stringify([eventDataTopic, "live.leagues", "prematch.leagues"])}]`,
      );
      return;
    }
    const topic = parseBinaryAttachmentTopic(frame);
    if (topic !== null) {
      this.pendingBinaryTopic = topic;
    }
  }

  private async handleBinaryFrame(rawBytes: Uint8Array): Promise<void> {
    const topic = this.pendingBinaryTopic;
    this.pendingBinaryTopic = null;
    if (!topic) return;

    // Strip optional Engine.IO binary message prefix byte (0x04) before gzip magic (0x1f 0x8b)
    const bytes =
      rawBytes.byteLength >= 3 &&
      rawBytes[0] === 0x04 &&
      rawBytes[1] === 0x1f &&
      rawBytes[2] === 0x8b
        ? rawBytes.subarray(1)
        : rawBytes;

    this.framesReceived += 1;
    const decoded = await decodeSpandoraFrame(bytes);
    const nowMs = defaultWallClock.nowMs();
    const lineSet = this.getLineSet();
    const eventDataTopic = eventDataTopicForFlavor(lineSet, this.flavor);
    const coeffPrefix = `${this.flavor}.main.${lineSet}.eventCoefficients.`;

    if (topic === "live.leagues" || topic === "prematch.leagues") {
      this.processLeaguesFrame(decoded, topic, nowMs);
      return;
    }
    if (topic === eventDataTopic) {
      this.processEventDataFrame(decoded, topic, nowMs);
      return;
    }
    if (topic.startsWith(coeffPrefix)) {
      const eventId = Number(topic.slice(coeffPrefix.length));
      if (Number.isFinite(eventId) && eventId > 0) {
        this.processCoefficientsFrame(eventId, decoded, topic, nowMs);
      }
    }
  }

  private processLeaguesFrame(
    decoded: Awaited<ReturnType<typeof decodeSpandoraFrame>>,
    topic: string,
    nowMs: number,
  ): void {
    if (decoded.isDiff || !decoded.payload) return;
    const entries = extractLeagueCatalog(decoded.payload);
    if (entries.length === 0) return;

    this.ctx.storage.transactionSync(() => {
      for (const entry of entries) {
        this.ctx.storage.sql.exec(
          `INSERT INTO ppm_leagues (league_id, name, slug, updated_at_ms)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(league_id) DO UPDATE SET
             name = COALESCE(excluded.name, ppm_leagues.name),
             slug = COALESCE(excluded.slug, ppm_leagues.slug),
             updated_at_ms = excluded.updated_at_ms`,
          entry.leagueId,
          entry.name,
          entry.slug,
          nowMs,
        );
      }
    });

    // Unsubscribe once hydrated so we don't re-stream 9k+ static league objects
    this.sendText(`42["unsubscribe",${JSON.stringify([topic])}]`);
    this.logStructured("info", "hydrated ppm_leagues catalog", {
      topic,
      entries: entries.length,
    });
  }

  private processEventDataFrame(
    decoded: Awaited<ReturnType<typeof decodeSpandoraFrame>>,
    topic: string,
    nowMs: number,
  ): void {
    const toUnsubscribe: string[] = [];

    if (!decoded.isDiff && decoded.payload) {
      this.eventDataDoc = decoded.payload;
      const liveEvents = extractLiveEventsFromEventData(decoded.payload);
      const liveNow = new Set<number>();
      const maxSub = this.getMaxSubscribedEvents();
      const newSubs: string[] = [];

      for (const ev of liveEvents) {
        const matchesFlavor =
          this.flavor === "prematch" ? !ev.inPlay : ev.inPlay;
        if (!matchesFlavor) continue;
        liveNow.add(ev.eventId);
        const prev = this.eventState.get(ev.eventId);
        this.eventState.set(ev.eventId, {
          home: prev?.home ?? null,
          away: prev?.away ?? null,
          isBlocked: ev.isBlocked,
          sportId: ev.sportId,
          leagueId: ev.leagueId,
        });
        if (
          !this.subscribedIds.has(ev.eventId) &&
          this.subscribedIds.size < maxSub
        ) {
          this.subscribedIds.add(ev.eventId);
          newSubs.push(
            liveCoefficientsTopic(ev.eventId, this.getLineSet(), this.flavor),
          );
        }
      }

      for (const existingId of this.subscribedIds) {
        if (!liveNow.has(existingId)) {
          this.subscribedIds.delete(existingId);
          this.coeffDocs.delete(existingId);
          this.eventState.delete(existingId);
          toUnsubscribe.push(
            liveCoefficientsTopic(existingId, this.getLineSet(), this.flavor),
          );
        }
      }

      if (newSubs.length > 0) {
        this.sendText(`42["subscribe",${JSON.stringify(newSubs)}]`);
      }
    } else if (decoded.isDiff && decoded.patch) {
      applyJsonPatchInPlace(this.eventDataDoc, decoded.patch);
      for (const op of decoded.patch) {
        if (op.op === "remove") {
          const rmMatch = EVENT_DATA_REMOVE_RE.exec(op.path);
          if (rmMatch) {
            const eid = Number(rmMatch[4]);
            if (this.subscribedIds.delete(eid)) {
              this.coeffDocs.delete(eid);
              this.eventState.delete(eid);
              toUnsubscribe.push(
                liveCoefficientsTopic(eid, this.getLineSet(), this.flavor),
              );
            }
          }
          continue;
        }

        const lockMatch = EVENT_DATA_LOCK_RE.exec(op.path);
        if (!lockMatch) continue;
        const sportId = Number(lockMatch[1]);
        // Path is /s/<sportId>/<countryId>/<leagueId>/<eventId>/12/<field>
        const leagueId = Number(lockMatch[3]);
        const eid = Number(lockMatch[4]);
        const field = lockMatch[5];

        if (
          field === "ip" &&
          ((this.flavor === "live" && op.value === false) ||
            (this.flavor === "prematch" && op.value === true))
        ) {
          if (this.flavor === "prematch" && op.value === true) {
            // Snapshot final prematch coefficients as authoritative closing lines before unsubscribing.
            this.snapshotClosingLines(
              eid,
              decoded.ti?.t ?? nowMs,
              liveCoefficientsTopic(eid, this.getLineSet(), this.flavor),
              decoded.rawSha256,
            );
          }
          if (this.subscribedIds.delete(eid)) {
            this.coeffDocs.delete(eid);
            this.clearEventLineSignatures(eid);
            this.eventState.delete(eid);
            toUnsubscribe.push(
              liveCoefficientsTopic(eid, this.getLineSet(), this.flavor),
            );
          }
          continue;
        }

        if (field === "l") {
          const isBlocked = op.value === true || op.value === 1;
          const prev = this.eventState.get(eid) ?? {
            home: null,
            away: null,
            isBlocked: false,
            sportId,
            leagueId,
          };
          prev.isBlocked = isBlocked;
          this.eventState.set(eid, prev);
          this.insertTick({
            event_id: eid,
            ts_ms: decoded.ti?.t ?? nowMs,
            sport_id: prev.sportId,
            league_id: prev.leagueId,
            home_score: prev.home,
            away_score: prev.away,
            period: null,
            clock_sec: null,
            is_blocked: isBlocked ? 1 : 0,
            score_changed: 0,
            source_topic: topic,
            raw_sha256: decoded.rawSha256,
          });
        }
      }
    }

    if (toUnsubscribe.length > 0) {
      this.unsubscribedCount += toUnsubscribe.length;
      this.sendText(`42["unsubscribe",${JSON.stringify(toUnsubscribe)}]`);
    }
  }

  private processCoefficientsFrame(
    eventId: number,
    decoded: Awaited<ReturnType<typeof decodeSpandoraFrame>>,
    topic: string,
    nowMs: number,
  ): void {
    let doc = this.coeffDocs.get(eventId);
    if (!decoded.isDiff && decoded.payload) {
      doc = decoded.payload;
      this.coeffDocs.set(eventId, doc);
    } else if (decoded.isDiff && decoded.patch && doc) {
      applyJsonPatchInPlace(doc, decoded.patch);
    } else {
      return;
    }

    const snap = extractScoreSnapshot(doc);
    const prev = this.eventState.get(eventId) ?? {
      home: null,
      away: null,
      isBlocked: false,
      sportId: 0,
      leagueId: 0,
    };

    const scoreChanged =
      prev.home !== null &&
      prev.away !== null &&
      snap.homeScore !== null &&
      snap.awayScore !== null &&
      (snap.homeScore !== prev.home || snap.awayScore !== prev.away);

    if (snap.homeScore !== null) prev.home = snap.homeScore;
    if (snap.awayScore !== null) prev.away = snap.awayScore;
    this.eventState.set(eventId, prev);

    const tickTsMs = snap.updatedAtMs ?? decoded.ti?.t ?? nowMs;
    this.insertTick({
      event_id: eventId,
      ts_ms: tickTsMs,
      sport_id: prev.sportId,
      league_id: prev.leagueId,
      home_score: snap.homeScore,
      away_score: snap.awayScore,
      period: snap.period,
      clock_sec: snap.clockSec,
      is_blocked: prev.isBlocked ? 1 : 0,
      score_changed: scoreChanged ? 1 : 0,
      source_topic: topic,
      raw_sha256: decoded.rawSha256,
    });
    this.persistChangedMarketLines(
      eventId,
      doc,
      tickTsMs,
      prev,
      topic,
      decoded.rawSha256,
      false,
    );
  }

  private clearEventLineSignatures(eventId: number): void {
    const prefix = `${eventId}:`;
    for (const key of this.lastLineSignature.keys()) {
      if (key.startsWith(prefix)) this.lastLineSignature.delete(key);
    }
  }

  private snapshotClosingLines(
    eventId: number,
    tsMs: number,
    topic: string,
    rawSha256: string,
  ): void {
    const doc = this.coeffDocs.get(eventId);
    if (!doc) return;
    const prev = this.eventState.get(eventId) ?? {
      home: null,
      away: null,
      isBlocked: false,
      sportId: 0,
      leagueId: 0,
    };
    this.persistChangedMarketLines(
      eventId,
      doc,
      tsMs,
      prev,
      topic,
      rawSha256,
      true,
    );
  }

  private persistChangedMarketLines(
    eventId: number,
    doc: Record<string, unknown>,
    tsMs: number,
    state: ScoreState,
    topic: string,
    rawSha256: string,
    isClosing: boolean,
  ): void {
    const lines = extractMarketLinesFromCoefficients(doc);
    if (lines.length === 0) return;
    const lineSet = this.getLineSet();
    for (const m of lines) {
      const sigKey = `${eventId}:${m.marketId}:${m.periodKind}`;
      const sigVal = `${m.line ?? "null"}|${m.oddsA ?? "null"}|${m.oddsB ?? "null"}`;
      if (!isClosing && this.lastLineSignature.get(sigKey) === sigVal) {
        continue;
      }
      this.lastLineSignature.set(sigKey, sigVal);
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO ppm_line_ticks
         (event_id, ts_ms, line_set, flavor, sport_id, league_id, market_id, market_kind, period_kind, line, odds_a, odds_b, is_closing, source_topic, raw_sha256, flushed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        eventId,
        tsMs,
        lineSet,
        this.flavor,
        state.sportId,
        state.leagueId,
        m.marketId,
        m.marketKind,
        m.periodKind,
        m.line,
        m.oddsA,
        m.oddsB,
        isClosing ? 1 : 0,
        topic,
        rawSha256,
      );
    }
  }

  private insertTick(tick: PpmTickRecord): void {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO ppm_live_ticks
       (event_id, ts_ms, sport_id, league_id, home_score, away_score, period, clock_sec, is_blocked, score_changed, source_topic, raw_sha256, flushed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      tick.event_id,
      tick.ts_ms,
      tick.sport_id,
      tick.league_id,
      tick.home_score,
      tick.away_score,
      tick.period,
      tick.clock_sec,
      tick.is_blocked,
      tick.score_changed,
      tick.source_topic,
      tick.raw_sha256,
    );
  }

  private pruneExpiredTicks(): void {
    const cutoffMs = defaultWallClock.nowMs() - this.getRetentionMs();
    this.ctx.storage.sql.exec(
      "DELETE FROM ppm_live_ticks WHERE flushed = 1 AND ts_ms < ?",
      cutoffMs,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM ppm_line_ticks WHERE flushed = 1 AND is_closing = 0 AND ts_ms < ?",
      cutoffMs,
    );
  }

  /** Flush pending unflushed ticks to R2 using immutable chunk `If-None-Match: *` + manifest CAS. */
  async flushNow(): Promise<FlushTicksResult> {
    const rows = this.ctx.storage.sql
      .exec<PpmTickRecord>(
        `SELECT event_id, ts_ms, sport_id, league_id, home_score, away_score,
                period, clock_sec, is_blocked, score_changed, source_topic, raw_sha256
         FROM ppm_live_ticks
         WHERE flushed = 0
         ORDER BY ts_ms ASC, event_id ASC
         LIMIT ?`,
        MAX_FLUSH_BATCH,
      )
      .toArray();

    const result = await flushTicksBatchToR2(
      this.env.REPORTS_BUCKET,
      rows,
      this.getTaxonomy(),
      defaultWallClock,
      this.flavor === "prematch"
        ? {
            manifestKey: "manifests/ppm-prematch-ticks/latest",
            chunkPrefix: "ppm-prematch-ticks/chunks",
            sinkId: "ppm-prematch-ticks",
          }
        : undefined,
    );

    if (rows.length > 0) {
      const maxTs = rows[rows.length - 1]!.ts_ms;
      this.ctx.storage.sql.exec(
        "UPDATE ppm_live_ticks SET flushed = 1 WHERE flushed = 0 AND ts_ms <= ?",
        maxTs,
      );
      this.lastFlush = result;
      this.logStructured("info", "flushed ppm_live_ticks batch to R2", {
        flushedRows: result.flushedRows,
        chunkKey: result.chunkKey,
        generationU32: result.generationU32,
      });
    }

    const lineRows = this.ctx.storage.sql
      .exec<PpmLineTickRecord>(
        `SELECT event_id, ts_ms, line_set, flavor, sport_id, league_id,
                market_id, market_kind, period_kind, line, odds_a, odds_b,
                is_closing, source_topic, raw_sha256
         FROM ppm_line_ticks
         WHERE flushed = 0
         ORDER BY ts_ms ASC, event_id ASC
         LIMIT ?`,
        MAX_FLUSH_BATCH,
      )
      .toArray();
    if (lineRows.length > 0) {
      const lineResult = await flushLineTicksBatchToR2(
        this.env.REPORTS_BUCKET,
        lineRows,
        this.getTaxonomy(),
        defaultWallClock,
        this.flavor === "prematch"
          ? {
              manifestKey: "manifests/ppm-prematch-lines/latest",
              chunkPrefix: "ppm-prematch-lines/chunks",
              sinkId: "ppm-prematch-lines",
            }
          : {
              manifestKey: "manifests/ppm-live-lines/latest",
              chunkPrefix: "ppm-live-lines/chunks",
              sinkId: "ppm-live-lines",
            },
      );
      const maxLineTs = lineRows[lineRows.length - 1]!.ts_ms;
      this.ctx.storage.sql.exec(
        "UPDATE ppm_line_ticks SET flushed = 1 WHERE flushed = 0 AND ts_ms <= ?",
        maxLineTs,
      );
      this.lastLineFlush = lineResult;
      this.logStructured("info", "flushed ppm_line_ticks batch to R2", {
        flushedRows: lineResult.flushedRows,
        chunkKey: lineResult.chunkKey,
        generationU32: lineResult.generationU32,
      });
    }
    this.lastFlushNs = defaultMonotonicClock.nowNs();
    return result;
  }

  /** Query stored PPM market line & odds ticks (or closing snapshots) for Partner 118 `eID`s. */
  queryLines(
    eventIds: readonly number[],
    options: {
      readonly fromMs?: number;
      readonly toMs?: number;
      readonly closingOnly?: boolean;
      readonly marketKind?: string | null;
      readonly periodKind?: string | null;
      readonly limit?: number;
    } = {},
  ): PpmLineTickRecord[] {
    const cleanIds = eventIds
      .filter((id) => Number.isInteger(id) && id > 0)
      .slice(0, 100);
    if (cleanIds.length === 0) return [];
    const fromMs = Number.isFinite(options.fromMs) ? options.fromMs! : 0;
    const toMs = Number.isFinite(options.toMs)
      ? options.toMs!
      : Number.MAX_SAFE_INTEGER;
    const safeLimit = Math.max(
      1,
      Math.min(5_000, Math.trunc(options.limit ?? 2_000)),
    );
    const placeholders = cleanIds.map(() => "?").join(",");
    const clauses = [
      `event_id IN (${placeholders})`,
      "ts_ms >= ?",
      "ts_ms <= ?",
    ];
    const params: Array<number | string> = [...cleanIds, fromMs, toMs];
    if (options.closingOnly) {
      clauses.push("is_closing = 1");
    }
    if (options.marketKind && options.marketKind.trim() !== "") {
      clauses.push("market_kind = ?");
      params.push(options.marketKind.trim().toUpperCase());
    }
    if (options.periodKind && options.periodKind.trim() !== "") {
      clauses.push("period_kind = ?");
      params.push(options.periodKind.trim().toUpperCase());
    }
    params.push(safeLimit);
    return this.ctx.storage.sql
      .exec<PpmLineTickRecord>(
        `SELECT event_id, ts_ms, line_set, flavor, sport_id, league_id,
                market_id, market_kind, period_kind, line, odds_a, odds_b,
                is_closing, source_topic, raw_sha256
         FROM ppm_line_ticks
         WHERE ${clauses.join(" AND ")}
         ORDER BY event_id ASC, market_kind ASC, period_kind ASC, ts_ms ASC
         LIMIT ?`,
        ...params,
      )
      .toArray();
  }

  /** Query stored ticks for one or more Partner 118 `eID`s within a `[fromMs, toMs]` window, joined with `ppm_leagues`. */
  queryTicks(
    eventIds: readonly number[],
    fromMs = 0,
    toMs = Number.MAX_SAFE_INTEGER,
    limit = 2_000,
  ): PpmEnrichedTickRecord[] {
    const cleanIds = eventIds
      .filter((id) => Number.isInteger(id) && id > 0)
      .slice(0, 100);
    if (cleanIds.length === 0) return [];
    const safeLimit = Math.max(1, Math.min(5_000, Math.trunc(limit)));
    const placeholders = cleanIds.map(() => "?").join(",");
    return this.ctx.storage.sql
      .exec<PpmEnrichedTickRecord>(
        `SELECT t.event_id, t.ts_ms, t.sport_id, t.league_id, t.home_score, t.away_score,
                t.period, t.clock_sec, t.is_blocked, t.score_changed, t.source_topic, t.raw_sha256,
                l.name AS league_name, l.slug AS league_slug
         FROM ppm_live_ticks t
         LEFT JOIN ppm_leagues l ON l.league_id = t.league_id
         WHERE t.event_id IN (${placeholders}) AND t.ts_ms >= ? AND t.ts_ms <= ?
         ORDER BY t.event_id ASC, t.ts_ms ASC
         LIMIT ?`,
        ...cleanIds,
        fromMs,
        toMs,
        safeLimit,
      )
      .toArray();
  }

  /** Query hydrated Pandora league names (`live.leagues` + `prematch.leagues`). */
  queryLeagues(leagueIds?: readonly number[], limit = 200): PpmLeagueRow[] {
    const safeLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
    if (leagueIds && leagueIds.length > 0) {
      const cleanIds = leagueIds
        .filter((id) => Number.isInteger(id) && id > 0)
        .slice(0, 200);
      if (cleanIds.length === 0) return [];
      const placeholders = cleanIds.map(() => "?").join(",");
      return this.ctx.storage.sql
        .exec<PpmLeagueRow>(
          `SELECT league_id, name, slug, updated_at_ms
           FROM ppm_leagues
           WHERE league_id IN (${placeholders})
           ORDER BY league_id ASC
           LIMIT ?`,
          ...cleanIds,
          safeLimit,
        )
        .toArray();
    }
    return this.ctx.storage.sql
      .exec<PpmLeagueRow>(
        `SELECT league_id, name, slug, updated_at_ms
         FROM ppm_leagues
         ORDER BY league_id ASC
         LIMIT ?`,
        safeLimit,
      )
      .toArray();
  }

  /** Evaluate a bet's `[placedMs, acceptedMs]` timing window against stored live ticks. */
  evaluateBet(input: BetAnomalyEvaluationInput): BetAnomalyEvaluation {
    const snipeThresholdMs = input.snipeThresholdMs ?? 15_000;
    const stallWindowMs = input.stallWindowMs ?? 30_000;
    const windowFrom = input.placedMs - stallWindowMs;
    const windowTo = input.acceptedMs + 120_000;
    const ticks = this.queryTicks([input.eventId], windowFrom, windowTo, 1_000);

    let latestAtPlacementMs: number | null = null;
    let latestAtAcceptBlocked = false;
    let hasTickAtOrBeforeAccept = false;
    let scoreDuringDelay = false;
    let firstScoreAfterPlacementMs: number | null = null;

    for (const tick of ticks) {
      if (tick.ts_ms <= input.placedMs) {
        latestAtPlacementMs = tick.ts_ms;
      }
      if (tick.ts_ms <= input.acceptedMs) {
        latestAtAcceptBlocked = tick.is_blocked === 1;
        hasTickAtOrBeforeAccept = true;
      }
      if (
        tick.score_changed === 1 &&
        tick.ts_ms > input.placedMs &&
        tick.ts_ms <= input.acceptedMs
      ) {
        scoreDuringDelay = true;
      }
      if (
        tick.score_changed === 1 &&
        tick.ts_ms >= input.placedMs &&
        firstScoreAfterPlacementMs === null
      ) {
        firstScoreAfterPlacementMs = tick.ts_ms;
      }
    }

    const timeUntilScoreMs =
      firstScoreAfterPlacementMs === null
        ? null
        : firstScoreAfterPlacementMs - input.placedMs;
    const acceptedWhileBlocked =
      hasTickAtOrBeforeAccept && latestAtAcceptBlocked;
    const feedStallAtPlacement =
      latestAtPlacementMs === null ||
      input.placedMs - latestAtPlacementMs > stallWindowMs;

    const flags: string[] = [];
    if (scoreDuringDelay) flags.push("SCORE_DURING_DELAY_WINDOW");
    if (timeUntilScoreMs !== null && timeUntilScoreMs <= 5_000)
      flags.push("SUB_5S_SCORE_SNIPE");
    else if (
      timeUntilScoreMs !== null &&
      timeUntilScoreMs <= snipeThresholdMs
    ) {
      flags.push("SUB_15S_SCORE_SNIPE");
    }
    if (acceptedWhileBlocked) flags.push("ACCEPTED_WHILE_BLOCKED");
    if (feedStallAtPlacement) flags.push("FEED_STALL_AT_PLACEMENT");

    return {
      eventId: input.eventId,
      placedMs: input.placedMs,
      acceptedMs: input.acceptedMs,
      ticksInspected: ticks.length,
      timeUntilScoreMs,
      scoreDuringDelay,
      acceptedWhileBlocked,
      feedStallAtPlacement,
      flags,
    };
  }

  /** Read-only operational snapshot (safe for `/health`, zero PII/secrets). */
  getStatus(): CollectorStatus {
    const stats = this.ctx.storage.sql
      .exec<{ total: number; unflushed: number; max_ts: number | null }>(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN flushed = 0 THEN 1 ELSE 0 END) AS unflushed,
                MAX(ts_ms) AS max_ts
         FROM ppm_live_ticks`,
      )
      .one();
    const lineStats = this.ctx.storage.sql
      .exec<{ total: number; unflushed: number; closing: number }>(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN flushed = 0 THEN 1 ELSE 0 END) AS unflushed,
                SUM(CASE WHEN is_closing = 1 THEN 1 ELSE 0 END) AS closing
         FROM ppm_line_ticks`,
      )
      .one();
    const leaguesRow = this.ctx.storage.sql
      .exec<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM ppm_leagues")
      .one();

    const nowNs = defaultMonotonicClock.nowNs();
    return {
      instanceId: this.getInstanceId(),
      flavor: this.flavor,
      taxonomy: this.getTaxonomy(),
      connected: this.connected,
      running: this.running,
      leaguesCount: Number(leaguesRow.cnt ?? 0),
      subscribedEvents: this.subscribedIds.size,
      unsubscribedCount: this.unsubscribedCount,
      textFramesReceived: this.textFramesReceived,
      binaryFramesReceived: this.binaryFramesReceived,
      lastTextFramePrefix: this.lastTextFramePrefix,
      framesReceived: this.framesReceived,
      ticksStoredTotal: Number(stats.total ?? 0),
      ticksUnflushed: Number(stats.unflushed ?? 0),
      lineTicksStoredTotal: Number(lineStats.total ?? 0),
      lineTicksUnflushed: Number(lineStats.unflushed ?? 0),
      closingLinesStoredTotal: Number(lineStats.closing ?? 0),
      reconnectAttempts: this.reconnectAttempts,
      lastHeartbeatAgeMs:
        this.lastHeartbeatNs === null
          ? null
          : Math.round(elapsedMsFromNs(this.lastHeartbeatNs, nowNs)),
      lastTickTsMs: stats.max_ts === null ? null : Number(stats.max_ts),
      lastFlush: this.lastFlush,
      lastLineFlush: this.lastLineFlush,
      lastError: this.lastError,
    };
  }
}
