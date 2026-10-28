import { describe, expectTypeOf, test } from "bun:test";

describe("Environment Variable Type Parity (Bun.env vs process.env)", () => {
  test("test_assert_type_parity_between_bun_env_and_process_env", () => {
    // Verify interface merging propagation across Bun.Env and NodeJS.ProcessEnv
    expectTypeOf<typeof Bun.env.PORT>().toEqualTypeOf<
      typeof process.env.PORT
    >();
    expectTypeOf<typeof Bun.env.HOST>().toEqualTypeOf<
      typeof process.env.HOST
    >();
    expectTypeOf<typeof Bun.env.HOSTNAME>().toEqualTypeOf<
      typeof process.env.HOSTNAME
    >();
    expectTypeOf<typeof Bun.env.NODE_ENV>().toEqualTypeOf<
      typeof process.env.NODE_ENV
    >();

    // Gateway variables
    expectTypeOf<typeof Bun.env.F402_BASE_URL>().toEqualTypeOf<
      typeof process.env.F402_BASE_URL
    >();
    expectTypeOf<typeof Bun.env.F402_AGENT_ID>().toEqualTypeOf<
      typeof process.env.F402_AGENT_ID
    >();
    expectTypeOf<typeof Bun.env.F402_PASSWORD>().toEqualTypeOf<
      typeof process.env.F402_PASSWORD
    >();

    // Cloudflare & R2 variables
    expectTypeOf<typeof Bun.env.CLOUDFLARE_API_TOKEN>().toEqualTypeOf<
      typeof process.env.CLOUDFLARE_API_TOKEN
    >();
    expectTypeOf<typeof Bun.env.R2_BUCKET_NAME>().toEqualTypeOf<
      typeof process.env.R2_BUCKET_NAME
    >();

    // Telegram Bot & Mini App variables
    expectTypeOf<typeof Bun.env.TELEGRAM_BOT_TOKEN>().toEqualTypeOf<
      typeof process.env.TELEGRAM_BOT_TOKEN
    >();
    expectTypeOf<typeof Bun.env.TELEGRAM_CHAT_ID>().toEqualTypeOf<
      typeof process.env.TELEGRAM_CHAT_ID
    >();
    expectTypeOf<typeof Bun.env.TELEGRAM_MINIAPP_URL>().toEqualTypeOf<
      typeof process.env.TELEGRAM_MINIAPP_URL
    >();
  });
});
