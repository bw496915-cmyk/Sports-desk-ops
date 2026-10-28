/**
 * @file env.d.ts
 * @description Bun Environment Variable Type Declarations via Interface Merging.
 *
 * Extends `Bun.Env` and `process.env` with typed SportsDesk & Fantasy402 variables
 * following official Bun environment documentation.
 */

declare module "bun" {
  interface Env {
    // Runtime & Network Configuration
    readonly PORT?: string;
    readonly HOST?: string;
    readonly HOSTNAME?: string;
    readonly NODE_ENV?: "production" | "development" | "test";

    // Fantasy402 Portal Gateway
    readonly F402_BASE_URL?: string;
    readonly F402_AGENT_ID?: string;
    readonly F402_PASSWORD?: string;
    readonly F402_OFFLINE_ONLY?: string;
    readonly F402_INITIAL_WATERMARK?: string;

    // Cloudflare API & R2 Storage
    readonly CLOUDFLARE_ACCOUNT_ID?: string;
    readonly CLOUDFLARE_API_TOKEN?: string;
    readonly R2_ACCESS_KEY_ID?: string;
    readonly R2_SECRET_ACCESS_KEY?: string;
    readonly R2_ENDPOINT?: string;
    readonly R2_BUCKET_NAME?: string;
    readonly R2_PUBLIC_URL?: string;

    // Telegram Bot & Mini App Integration
    readonly TELEGRAM_BOT_TOKEN?: string;
    readonly TELEGRAM_BOT_USERNAME?: string;
    readonly TELEGRAM_CHAT_ID?: string;
    readonly TELEGRAM_MINIAPP_URL?: string;
    readonly TELEGRAM_WEBHOOK_URL?: string;
    readonly TELEGRAM_WEBHOOK_SECRET?: string;
    readonly TELEGRAM_ALERT_THRESHOLD_CENTS?: string;
    readonly TELEGRAM_REPORT_SCHEDULE?: string;
  }
}

declare global {
  namespace NodeJS {
    interface ProcessEnv extends Bun.Env {}
  }
}
