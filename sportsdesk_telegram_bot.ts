#!/usr/bin/env bun
/**
 * @file sportsdesk_telegram_bot.ts
 * @description Telegram Bot & Mini App Integration with Real-Time Watch List Alerts & Scheduled Reporting (Bun v1.4+).
 *
 * Capabilities:
 *  1. Telegram Bot API Client with dual-mode execution (Live Bot API & Offline Simulation).
 *  2. Real-Time Watch List Alert Engine: triggers immediate high-priority alerts when monitored
 *     sharp accounts (RF2003, BGD101, GP300, AT10359, ABC700, etc.) or high-stake wagers hit the book.
 *  3. Telegram Mini App (TMA) Extension: attaches inline WebApp buttons to launch the live
 *     interactive dashboard directly within Telegram, with query-parameter deep linking.
 *  4. Scheduled Reporting Engine: automated cron/interval reporting for Morning Risk Briefing,
 *     Midday Steam Pulse, and Evening Settlement Recaps.
 *  5. Interactive Chat Commands: /start, /miniapp, /report, /forensics, /watchlist, /check <ID>, /alert_test.
 */

import crypto from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface WatchListAccount {
  readonly customerId: string;
  readonly agentId: string;
  readonly masterAgentId: string;
  readonly archetype: string;
  readonly recentNetUSD: number;
  readonly lifetimeNetUSD: number;
  readonly sportsHandleUSD: number;
  readonly ticketsCount: number;
  readonly riskTier:
    | "CRITICAL_WHALE"
    | "EXECUTION_SNIPER"
    | "STEAM_CHASER"
    | "CHRONIC_SHARP"
    | "HIT_AND_RUN_DORMANT";
  readonly recommendedAction: string;
}

export interface WagerAlertPayload {
  readonly customerId: string;
  readonly agentId: string;
  readonly masterAgentId: string;
  readonly wagerNumber: number;
  readonly riskUSD: number;
  readonly toWinUSD: number;
  readonly odds: string;
  readonly marketDescription: string;
  readonly wagerType: string;
  readonly acceptedAt: string;
  readonly watchAccount?: WatchListAccount;
}

export interface TelegramInlineKeyboardButton {
  readonly text: string;
  readonly url?: string;
  readonly callback_data?: string;
  readonly web_app?: { readonly url: string };
}

export interface TelegramSendMessageOptions {
  readonly parse_mode?: "HTML" | "Markdown" | "MarkdownV2";
  readonly disable_web_page_preview?: boolean;
  readonly reply_markup?: {
    readonly inline_keyboard?: readonly (readonly TelegramInlineKeyboardButton[])[];
  };
}

export interface ScheduledReportTask {
  readonly id: string;
  readonly name: string;
  readonly cronExpression: string; // e.g. "08:00", "13:00", "23:00"
  readonly reportType:
    "MORNING_BRIEFING" | "MIDDAY_STEAM" | "EVENING_SETTLEMENT";
  readonly description: string;
}

export const REPORT_TYPES = [
  "MORNING_BRIEFING",
  "MIDDAY_STEAM",
  "EVENING_SETTLEMENT",
] as const satisfies readonly ScheduledReportTask["reportType"][];

export type ReportGenerator = (type: ScheduledReportTask["reportType"]) => {
  readonly contentHtml: string;
};

interface TelegramApiResult<T> {
  readonly ok: boolean;
  readonly result?: T;
  readonly description?: string;
  readonly error_code?: number;
}

interface TelegramChat {
  readonly id: number;
  readonly type: string;
}

export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: {
    readonly message_id: number;
    readonly chat: TelegramChat;
    readonly text?: string;
  };
  readonly callback_query?: {
    readonly id: string;
    readonly data?: string;
    readonly from: { readonly id: number; readonly username?: string };
    readonly message?: { readonly chat: TelegramChat };
  };
}

export interface TelegramBotStatus {
  readonly tokenConfigured: boolean;
  readonly bot: { readonly username: string } | null;
  readonly defaultChatConfigured: boolean;
  readonly mode: "live" | "simulation";
  readonly modeReason: string;
  readonly authorizedChatCount: number;
  readonly inbound: "webhook" | "polling" | "none";
  readonly webhook: {
    readonly url: string;
    readonly configuredUrl: string;
    readonly secretConfigured: boolean;
    readonly pendingUpdates: number;
    readonly lastError: string | null;
  } | null;
  readonly error: string | null;
}

export interface TelegramActivityEntry {
  readonly at: string;
  readonly direction: "in" | "out";
  readonly chatId: string;
  readonly summary: string;
  readonly outcome:
    "sent" | "simulated" | "failed" | "received" | "unauthorized";
  readonly detail?: string;
}

const ACTIVITY_MAX_BYTES = 512 * 1024;
const ACTIVITY_KEEP_LINES = 1_000;

function plainPreview(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/━+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

export class SportsDeskTelegramService {
  private readonly botToken: string;
  private readonly defaultChatId: string;
  private readonly miniappBaseUrl: string;
  private readonly apiBaseUrl: string;
  private readonly isLiveMode: boolean;
  private readonly authorizedChatIds: ReadonlySet<string>;
  private readonly webhookUrl: string;
  private readonly webhookSecret: string;
  private readonly watchListMap: Map<string, WatchListAccount> = new Map();
  private readonly scheduledReports: ScheduledReportTask[] = [];
  private readonly fetchSession: Bun.FetchSession;
  private reportGenerator: ReportGenerator | null = null;
  private pollingAbort: AbortController | null = null;
  private readonly activityLogPath: string | null;

  /**
   * `activityLogPath` is shared by the polling daemon and the web server (separate processes),
   * so the dashboard feed shows both; `null` disables it (the default under `bun test`).
   */
  constructor(options?: {
    botToken?: string;
    chatId?: string;
    miniappUrl?: string;
    apiBaseUrl?: string;
    activityLogPath?: string | null;
  }) {
    this.activityLogPath =
      options?.activityLogPath !== undefined
        ? options.activityLogPath
        : process.env.TELEGRAM_ACTIVITY_LOG ||
          (process.env.NODE_ENV === "test"
            ? null
            : resolve(import.meta.dir, "reports/telegram-activity.jsonl"));
    this.apiBaseUrl = options?.apiBaseUrl ?? "https://api.telegram.org";
    this.botToken = options?.botToken ?? process.env.TELEGRAM_BOT_TOKEN ?? "";
    this.defaultChatId = options?.chatId ?? process.env.TELEGRAM_CHAT_ID ?? "";
    this.miniappBaseUrl = (
      options?.miniappUrl ??
      process.env.TELEGRAM_MINIAPP_URL ??
      "http://localhost:4020"
    ).replace(/\/+$/, "");
    this.isLiveMode = Boolean(
      this.botToken &&
      this.botToken.trim().length > 0 &&
      this.defaultChatId.trim().length > 0,
    );
    this.authorizedChatIds = new Set(
      [
        this.defaultChatId,
        ...(process.env.TELEGRAM_ADMIN_CHAT_IDS ?? "").split(","),
      ]
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    );
    this.webhookUrl = process.env.TELEGRAM_WEBHOOK_URL ?? "";
    this.webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";

    this.fetchSession = new Bun.FetchSession({
      tls: {
        rejectUnauthorized: true,
      },
    });

    if (this.isLiveMode && typeof fetch.preconnect === "function") {
      try {
        fetch.preconnect(this.apiBaseUrl);
      } catch {
        // Non-blocking preconnect failure
      }
    }

    this.initWatchListRegistry();
    this.initScheduleDefinitions();
  }

  private initWatchListRegistry(): void {
    // 1. Whale
    this.watchListMap.set("RF2003", {
      customerId: "RF2003",
      agentId: "FAKEMONEY",
      masterAgentId: "BILLY666",
      archetype: "Whale Volatility Concentration",
      recentNetUSD: 25000.0,
      lifetimeNetUSD: -1006530.0,
      sportsHandleUSD: 940000.0,
      ticketsCount: 47,
      riskTier: "CRITICAL_WHALE",
      recommendedAction:
        "Cap max single bet to $5,000.00 / require split approvals",
    });

    // 2. Execution Snipers
    const snipers = [
      {
        id: "BGD101",
        agent: "BIGDAD",
        won: 40000.0,
        handle: 40000.0,
        tix: 2,
        lt: -177400.0,
      },
      {
        id: "MJ102",
        agent: "MJ2026",
        won: 30000.0,
        handle: 20000.0,
        tix: 1,
        lt: 24000.0,
      },
      {
        id: "GX195",
        agent: "GOLD22",
        won: 10000.0,
        handle: 10000.0,
        tix: 1,
        lt: 4403.0,
      },
      {
        id: "PEY101",
        agent: "MACHR",
        won: 10000.0,
        handle: 10000.0,
        tix: 1,
        lt: -102666.0,
      },
      {
        id: "MJ101",
        agent: "MJ2026",
        won: 10000.0,
        handle: 10000.0,
        tix: 1,
        lt: -77115.0,
      },
      {
        id: "TEX500",
        agent: "TEXANS",
        won: 8000.0,
        handle: 8000.0,
        tix: 2,
        lt: -7860.0,
      },
      {
        id: "AL1279",
        agent: "AA2300C",
        won: 6600.0,
        handle: 6000.0,
        tix: 2,
        lt: -125484.0,
      },
      {
        id: "BB5127",
        agent: "ATEAM",
        won: 5000.0,
        handle: 15000.0,
        tix: 3,
        lt: -1750.0,
      },
      {
        id: "19902",
        agent: "RALPHAH",
        won: 5000.0,
        handle: 5000.0,
        tix: 1,
        lt: 30650.0,
      },
    ];
    for (const s of snipers) {
      this.watchListMap.set(s.id, {
        customerId: s.id,
        agentId: s.agent,
        masterAgentId: "BILLY666",
        archetype: "Execution Sniper (100% Win Rate)",
        recentNetUSD: s.won,
        lifetimeNetUSD: s.lt,
        sportsHandleUSD: s.handle,
        ticketsCount: s.tix,
        riskTier: "EXECUTION_SNIPER",
        recommendedAction: "Slash single-wager limit to $1,000.00 immediately",
      });
    }

    // 3. Steam Chasers & Originators
    const steam = [
      {
        id: "GP300",
        agent: "GPRO50RSK",
        won: 33858.0,
        handle: 46140.0,
        tix: 22,
        lt: -1519.0,
      },
      {
        id: "AT10359",
        agent: "ATEAM",
        won: 19024.0,
        handle: 26500.0,
        tix: 21,
        lt: 45525.0,
      },
      {
        id: "BCC1530",
        agent: "SPEN",
        won: 10514.0,
        handle: 19722.0,
        tix: 31,
        lt: 3401.0,
      },
      {
        id: "AT811",
        agent: "ATEAM",
        won: 3967.0,
        handle: 5990.0,
        tix: 30,
        lt: 7854.0,
      },
      {
        id: "AYM59007",
        agent: "AYMAN",
        won: 3001.0,
        handle: 8925.0,
        tix: 24,
        lt: 2130.0,
      },
    ];
    for (const st of steam) {
      this.watchListMap.set(st.id, {
        customerId: st.id,
        agentId: st.agent,
        masterAgentId: "BILLY666",
        archetype: "High-Frequency Steam / Line Chaser",
        recentNetUSD: st.won,
        lifetimeNetUSD: st.lt,
        sportsHandleUSD: st.handle,
        ticketsCount: st.tix,
        riskTier: "STEAM_CHASER",
        recommendedAction:
          "Apply 6-second dynamic delay gate & shade juice to -115",
      });
    }

    // 4. Chronic Lifetime Sharps
    const chronic = [
      {
        id: "ABC700",
        agent: "JUICEPLUS",
        won: -4000.0,
        handle: 42000.0,
        tix: 5,
        lt: 200050.0,
      },
      {
        id: "DAN245",
        agent: "DAN318",
        won: 14000.0,
        handle: 14000.0,
        tix: 7,
        lt: 16049.0,
      },
      {
        id: "LG237",
        agent: "ROBERTL",
        won: 2500.0,
        handle: 2500.0,
        tix: 1,
        lt: 38550.0,
      },
      {
        id: "MM1012",
        agent: "MOOSEM",
        won: 2000.0,
        handle: 2000.0,
        tix: 2,
        lt: 10659.0,
      },
      {
        id: "MM1023",
        agent: "MOOSEM",
        won: 1900.0,
        handle: 6000.0,
        tix: 3,
        lt: 14000.0,
      },
    ];
    for (const c of chronic) {
      this.watchListMap.set(c.id, {
        customerId: c.id,
        agentId: c.agent,
        masterAgentId: "BILLY666",
        archetype: "Chronic Lifetime Extractor Sharp",
        recentNetUSD: c.won,
        lifetimeNetUSD: c.lt,
        sportsHandleUSD: c.handle,
        ticketsCount: c.tix,
        riskTier: "CHRONIC_SHARP",
        recommendedAction:
          "Shift to +15c/+20c vig model (-120/-110) or restrict markets",
      });
    }
  }

  private initScheduleDefinitions(): void {
    this.scheduledReports.push(
      {
        id: "rep_morning_0800",
        name: "Morning Risk Briefing",
        cronExpression: "08:00 EDT",
        reportType: "MORNING_BRIEFING",
        description:
          "Overnight risk exposure, dormant re-activations, top 5 toxic branches, and daily game slate.",
      },
      {
        id: "rep_midday_1300",
        name: "Midday Steam & Volatility Pulse",
        cronExpression: "13:00 EDT",
        reportType: "MIDDAY_STEAM",
        description:
          "Line movement alerts, steam originations from GP300/AT10359, and in-play ticket velocity.",
      },
      {
        id: "rep_evening_2300",
        name: "Evening Settlement Recap",
        cronExpression: "23:00 EDT",
        reportType: "EVENING_SETTLEMENT",
        description:
          "Day's settled handle, customer won/lost, net house hold, and agent 50% liability balance.",
      },
    );
  }

  public getWatchList(): ReadonlyMap<string, WatchListAccount> {
    return this.watchListMap;
  }

  public getScheduledReports(): readonly ScheduledReportTask[] {
    return this.scheduledReports;
  }

  public async sendMessage(
    chatId: string,
    htmlText: string,
    options?: TelegramSendMessageOptions & { readonly timeoutMs?: number },
  ): Promise<{ ok: boolean; message_id?: number; description?: string }> {
    const targetChat = chatId || this.defaultChatId;

    if (!this.botToken.trim() || !targetChat.trim()) {
      console.log(
        "\n================================================================================",
      );
      console.log(
        `[TELEGRAM OUTBOUND SIMULATION] Target Chat: ${targetChat || "DEFAULT_CHANNEL"}`,
      );
      console.log(
        "================================================================================",
      );
      console.log(htmlText.replace(/<[^>]*>/g, ""));
      await this.record({
        direction: "out",
        chatId: targetChat,
        summary: plainPreview(htmlText),
        outcome: "simulated",
        detail: this.botToken.trim()
          ? "TELEGRAM_CHAT_ID is not set"
          : "TELEGRAM_BOT_TOKEN is not set",
      });
      return { ok: true, message_id: Math.floor(Math.random() * 100000) };
    }

    const res = await this.api<{ message_id: number }>(
      "sendMessage",
      {
        chat_id: targetChat,
        text: htmlText,
        parse_mode: options?.parse_mode || "HTML",
        disable_web_page_preview: options?.disable_web_page_preview ?? true,
        reply_markup: options?.reply_markup,
      },
      options?.timeoutMs,
    );
    if (!res.ok) {
      console.error("[Telegram API Error] sendMessage:", res.description);
    }
    await this.record({
      direction: "out",
      chatId: targetChat,
      summary: plainPreview(htmlText),
      outcome: res.ok ? "sent" : "failed",
      ...(res.ok ? {} : { detail: res.description ?? "sendMessage failed" }),
    });
    return {
      ok: res.ok,
      ...(res.result?.message_id !== undefined
        ? { message_id: res.result.message_id }
        : {}),
      ...(res.description !== undefined ? { description: res.description } : {}),
    };
  }

  /** Newest first. */
  public async getActivity(limit = 50): Promise<TelegramActivityEntry[]> {
    if (!this.activityLogPath) return [];
    const file = Bun.file(this.activityLogPath);
    if (!(await file.exists())) return [];
    return (await file.text())
      .trimEnd()
      .split("\n")
      .slice(-limit)
      .reverse()
      .flatMap((line): TelegramActivityEntry[] => {
        try {
          return [JSON.parse(line) as TelegramActivityEntry];
        } catch {
          return [];
        }
      });
  }

  /** Best effort: a log failure must never block a send or a command. */
  private async record(
    entry: Omit<TelegramActivityEntry, "at">,
  ): Promise<void> {
    const path = this.activityLogPath;
    if (!path) return;
    try {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(
        path,
        `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
      );
      if (Bun.file(path).size > ACTIVITY_MAX_BYTES) {
        const lines = (await Bun.file(path).text()).trimEnd().split("\n");
        await Bun.write(
          path,
          `${lines.slice(-ACTIVITY_KEEP_LINES).join("\n")}\n`,
        );
      }
    } catch (err) {
      console.error("[Telegram] activity log write failed:", err);
    }
  }

  /** POST a Bot API method; never throws, transport failures come back as `ok: false`. */
  private async api<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 10_000,
    cancel?: AbortSignal,
  ): Promise<TelegramApiResult<T>> {
    if (!this.botToken.trim()) {
      return { ok: false, description: "TELEGRAM_BOT_TOKEN is not set" };
    }
    try {
      const res = await this.fetchSession.fetch(
        `${this.apiBaseUrl}/bot${this.botToken}/${method}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
          signal: cancel
            ? AbortSignal.any([AbortSignal.timeout(timeoutMs), cancel])
            : AbortSignal.timeout(timeoutMs),
        },
      );
      return (await res.json()) as TelegramApiResult<T>;
    } catch (err) {
      return {
        ok: false,
        description: err instanceof Error ? err.message : String(err),
      };
    }
  }

  public setReportGenerator(generator: ReportGenerator): void {
    this.reportGenerator = generator;
  }

  public isAuthorizedChat(chatId: string | number): boolean {
    return this.authorizedChatIds.has(String(chatId));
  }

  public isWebhookSecretValid(header: string | null): boolean {
    if (!this.webhookSecret || header === null) return false;
    const a = Buffer.from(header);
    const b = Buffer.from(this.webhookSecret);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  public async getStatus(): Promise<TelegramBotStatus> {
    const tokenConfigured = this.botToken.trim().length > 0;
    const defaultChatConfigured = this.defaultChatId.trim().length > 0;
    const modeReason = !tokenConfigured
      ? "TELEGRAM_BOT_TOKEN is not set"
      : !defaultChatConfigured
        ? "TELEGRAM_CHAT_ID is not set; alerts and reports only print to the console. Send /chatid to the bot to get it."
        : "Alerts and reports go to the default chat";
    const base = {
      tokenConfigured,
      defaultChatConfigured,
      mode: this.isLiveMode ? "live" : "simulation",
      modeReason,
      authorizedChatCount: this.authorizedChatIds.size,
    } as const;
    if (!tokenConfigured) {
      return {
        ...base,
        bot: null,
        inbound: "none",
        webhook: null,
        error: null,
      };
    }

    const [me, hook] = await Promise.all([
      this.api<{ username: string }>("getMe"),
      this.api<{
        url: string;
        pending_update_count: number;
        last_error_message?: string;
      }>("getWebhookInfo"),
    ]);
    const webhookUrl = hook.result?.url ?? "";
    return {
      ...base,
      bot: me.result ? { username: me.result.username } : null,
      inbound: webhookUrl ? "webhook" : this.pollingAbort ? "polling" : "none",
      webhook: hook.ok
        ? {
            url: webhookUrl,
            configuredUrl: this.webhookUrl,
            secretConfigured: this.webhookSecret.length > 0,
            pendingUpdates: hook.result?.pending_update_count ?? 0,
            lastError: hook.result?.last_error_message ?? null,
          }
        : null,
      error: me.ok ? null : (me.description ?? "getMe failed"),
    };
  }

  /** Registers TELEGRAM_WEBHOOK_URL with Telegram; refuses without a secret so the endpoint can authenticate callers. */
  public async setWebhook(): Promise<{ ok: boolean; description?: string }> {
    if (!this.webhookUrl) {
      return { ok: false, description: "TELEGRAM_WEBHOOK_URL is not set" };
    }
    if (!this.webhookSecret) {
      return { ok: false, description: "TELEGRAM_WEBHOOK_SECRET is not set" };
    }
    this.stopPolling();
    const res = await this.api<boolean>("setWebhook", {
      url: this.webhookUrl,
      secret_token: this.webhookSecret,
      allowed_updates: ["message", "callback_query"],
    });
    return {
      ok: res.ok,
      ...(res.description !== undefined ? { description: res.description } : {}),
    };
  }

  public async deleteWebhook(): Promise<{ ok: boolean; description?: string }> {
    const res = await this.api<boolean>("deleteWebhook");
    return {
      ok: res.ok,
      ...(res.description !== undefined ? { description: res.description } : {}),
    };
  }

  /** Long-polls getUpdates until {@link stopPolling}; Telegram rejects this while a webhook is set. */
  public async startPolling(): Promise<void> {
    if (this.pollingAbort) return;
    const abort = new AbortController();
    this.pollingAbort = abort;
    let offset = 0;
    console.log("[Telegram] Polling for updates (Ctrl+C to stop)");
    while (!abort.signal.aborted) {
      const res = await this.api<TelegramUpdate[]>(
        "getUpdates",
        { offset, timeout: 25, allowed_updates: ["message", "callback_query"] },
        35_000,
        abort.signal,
      );
      if (abort.signal.aborted) break;
      if (!res.ok) {
        console.error(`[Telegram] getUpdates failed: ${res.description}`);
        if (res.error_code === 409) break;
        await Bun.sleep(5_000);
        continue;
      }
      for (const update of res.result ?? []) {
        offset = update.update_id + 1;
        await this.handleUpdate(update).catch((err) =>
          console.error("[Telegram] update handler failed:", err),
        );
      }
    }
    this.pollingAbort = null;
  }

  public stopPolling(): void {
    this.pollingAbort?.abort();
  }

  public async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }
    const message = update.message;
    if (!message?.text?.startsWith("/")) return;

    const chatId = String(message.chat.id);
    const [rawCommand = "", ...args] = message.text.trim().split(/\s+/);
    const command = rawCommand.split("@")[0]!.toLowerCase();
    await this.record({
      direction: "in",
      chatId,
      summary: message.text.trim().slice(0, 160),
      outcome:
        command === "/chatid" || this.isAuthorizedChat(chatId)
          ? "received"
          : "unauthorized",
    });

    if (command === "/chatid") {
      await this.sendMessage(
        chatId,
        `This chat's ID is <code>${chatId}</code>.\nSet <code>TELEGRAM_CHAT_ID</code> (or add it to <code>TELEGRAM_ADMIN_CHAT_IDS</code>) to authorize it.`,
      );
      return;
    }
    if (!this.isAuthorizedChat(chatId)) {
      await this.sendMessage(
        chatId,
        `This chat is not authorized. Send /chatid and ask an admin to add <code>${chatId}</code>.`,
      );
      return;
    }

    switch (command) {
      case "/start":
      case "/help":
        await this.sendMessage(
          chatId,
          [
            "<b>SportsDesk bot</b>",
            "/miniapp - open the live dashboard",
            "/watchlist - monitored accounts",
            "/check &lt;ID&gt; - one account",
            "/report [MORNING_BRIEFING|MIDDAY_STEAM|EVENING_SETTLEMENT]",
            "/alert_test [ID] - send a sample watch list alert here",
            "/forensics - open the forensics tab",
            "/chatid - show this chat's ID",
          ].join("\n"),
          { reply_markup: this.miniappKeyboard("", chatId) },
        );
        return;
      case "/miniapp":
      case "/forensics":
        await this.sendMessage(chatId, "Open the SportsDesk dashboard:", {
          reply_markup: this.miniappKeyboard(
            command === "/forensics" ? "?tab=forensics" : "",
            chatId,
          ),
        });
        return;
      case "/watchlist": {
        const lines = [...this.watchListMap.values()].map(
          (a) =>
            `<code>${Bun.escapeHTML(a.customerId)}</code> ${Bun.escapeHTML(a.riskTier)} (agent <code>${Bun.escapeHTML(a.agentId)}</code>)`,
        );
        await this.sendMessage(
          chatId,
          `<b>Watch list (${lines.length})</b>\n${lines.join("\n")}`,
        );
        return;
      }
      case "/check": {
        const id = (args[0] ?? "").toUpperCase();
        const acct = this.watchListMap.get(id);
        await this.sendMessage(
          chatId,
          acct
            ? [
                `<b>${Bun.escapeHTML(acct.customerId)}</b> (${Bun.escapeHTML(acct.archetype)})`,
                `Agent <code>${Bun.escapeHTML(acct.agentId)}</code>, master <code>${Bun.escapeHTML(acct.masterAgentId)}</code>`,
                `Handle $${acct.sportsHandleUSD.toLocaleString("en-US")}, recent net $${acct.recentNetUSD.toLocaleString("en-US")}, lifetime net $${acct.lifetimeNetUSD.toLocaleString("en-US")}`,
                `Action: ${Bun.escapeHTML(acct.recommendedAction)}`,
              ].join("\n")
            : `No watch list account <code>${Bun.escapeHTML(id || "(none)")}</code>. Try /watchlist.`,
        );
        return;
      }
      case "/alert_test":
        await this.dispatchTestAlert(args[0] ?? "RF2003", chatId);
        return;
      case "/report": {
        const type = (args[0] ?? "EVENING_SETTLEMENT").toUpperCase();
        if (!isReportType(type)) {
          await this.sendMessage(
            chatId,
            `Unknown report. Use one of: ${REPORT_TYPES.join(", ")}`,
          );
          return;
        }
        await this.dispatchReport(type, chatId);
        return;
      }
      default:
        await this.sendMessage(chatId, "Unknown command. Send /help.");
    }
  }

  public async dispatchReport(
    type: ScheduledReportTask["reportType"],
    chatId?: string,
  ): Promise<boolean> {
    if (!this.reportGenerator) {
      console.error("[Telegram] no report generator registered");
      return false;
    }
    const res = await this.sendMessage(
      chatId ?? "",
      this.reportGenerator(type).contentHtml,
    );
    return res.ok;
  }

  private async handleCallback(
    query: NonNullable<TelegramUpdate["callback_query"]>,
  ): Promise<void> {
    const chatId = query.message?.chat.id;
    const authorized = chatId !== undefined && this.isAuthorizedChat(chatId);
    await this.record({
      direction: "in",
      chatId: String(chatId ?? query.from.id),
      summary: `button ${query.data ?? ""} from ${query.from.username ?? query.from.id}`,
      outcome: authorized ? "received" : "unauthorized",
    });
    if (!authorized) {
      await this.api("answerCallbackQuery", {
        callback_query_id: query.id,
        text: "Not authorized",
      });
      return;
    }
    const [action, customerId, value] = (query.data ?? "").split(":");
    const label =
      action === "slash"
        ? `Slash ${customerId} to $${Number(value).toLocaleString("en-US")}`
        : action === "delay"
          ? `Apply ${value}s delay to ${customerId}`
          : `Unknown action ${query.data}`;
    console.log(
      `[Telegram] ${label} requested by ${query.from.username ?? query.from.id}`,
    );
    await this.api("answerCallbackQuery", {
      callback_query_id: query.id,
      text: `${label}: recorded. Apply it in Fantasy402; the bot does not change accounts.`,
      show_alert: true,
    });
  }

  /** `web_app` buttons are rejected outside private chats (negative chat IDs), so groups get a plain link. */
  private miniappButton(
    text: string,
    query: string,
    chatId: string,
  ): TelegramInlineKeyboardButton {
    const url = `${this.miniappBaseUrl}${query}`;
    return chatId.startsWith("-") ? { text, url } : { text, web_app: { url } };
  }

  private miniappKeyboard(query: string, chatId: string) {
    return {
      inline_keyboard: [[this.miniappButton("Open SportsDesk", query, chatId)]],
    };
  }

  public async dispatchWatchListAlert(
    wager: WagerAlertPayload,
    targetChatId?: string,
  ): Promise<boolean> {
    const watchAcct =
      wager.watchAccount || this.watchListMap.get(wager.customerId);
    const chatId = targetChatId || this.defaultChatId;

    const riskFormatted = `$${wager.riskUSD.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
    const winFormatted = `$${wager.toWinUSD.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
    const archetype = watchAcct?.archetype || "High-Stake Exposure Threshold";
    const action =
      watchAcct?.recommendedAction ||
      "Review account wagering limits and confirmation delay";

    const alertHtml = `
🚨 <b>SPORTSDESK WATCH LIST WAGER ALERT</b> 🚨
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 <b>Bettor Account:</b> <code>${wager.customerId}</code>
👔 <b>Owning Sub-Agent:</b> <code>${wager.agentId}</code> (Master: <code>${wager.masterAgentId}</code>)
🏷 <b>Archetype:</b> ⚠️ <b>${archetype}</b>

💰 <b>Risk Amount:</b> <code>${riskFormatted}</code>
🎯 <b>To Win:</b> <code>${winFormatted}</code> (${wager.odds})
🏀 <b>Market / Leg:</b> <b>${wager.marketDescription}</b>
📋 <b>Wager Type:</b> <code>${wager.wagerType}</code> (Ticket #${wager.wagerNumber})
🕒 <b>Accepted At:</b> <code>${wager.acceptedAt}</code>

🛡 <b>Recommended Operational Action:</b>
${action}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

    const deepLinkQuery = `?${new URLSearchParams({ tab: "forensics", agent: wager.agentId, customer: wager.customerId })}`;

    const inlineKeyboard: TelegramInlineKeyboardButton[][] = [
      [this.miniappButton("🚀 Open in Live MiniApp", deepLinkQuery, chatId)],
      [
        {
          text: "⚡ Slash to $1k",
          callback_data: `slash:${wager.customerId}:1000`,
        },
        {
          text: "⏱ Apply 6s Delay",
          callback_data: `delay:${wager.customerId}:6`,
        },
      ],
    ];

    const result = await this.sendMessage(chatId, alertHtml.trim(), {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: inlineKeyboard },
    });

    return result.ok;
  }

  public async dispatchTestAlert(
    targetCustomerId: string = "RF2003",
    targetChatId?: string,
  ): Promise<boolean> {
    const custId = targetCustomerId.trim().toUpperCase();
    const watch = this.watchListMap.get(custId);

    const testPayload: WagerAlertPayload = {
      customerId: custId,
      agentId: watch?.agentId || "FAKEMONEY",
      masterAgentId: "BILLY666",
      wagerNumber: Math.floor(Math.random() * 900000) + 100000,
      riskUSD:
        custId === "RF2003" ? 20000.0 : custId === "BGD101" ? 20000.0 : 2500.0,
      toWinUSD:
        custId === "RF2003"
          ? 18181.82
          : custId === "BGD101"
            ? 18181.82
            : 2272.73,
      odds: "-110",
      marketDescription:
        "NFL • Kansas City Chiefs -3½ vs Denver Broncos (Point Spread)",
      wagerType: "Straight (Point Spread)",
      acceptedAt:
        new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC-5",
      ...(watch !== undefined ? { watchAccount: watch } : {}),
    };

    return this.dispatchWatchListAlert(testPayload, targetChatId);
  }
}

export function isReportType(
  value: string,
): value is ScheduledReportTask["reportType"] {
  return (REPORT_TYPES as readonly string[]).includes(value);
}

if (import.meta.main) {
  const { startBotDaemon } = await import("./reporting_scheduler_service.ts");
  await startBotDaemon();
}
