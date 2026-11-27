/**
 * Augments the `wrangler types`-generated `Env` interface with Wrangler secret bindings
 * (`wrangler secret put TICKS_API_TOKEN`) without duplicating `wrangler.jsonc` bindings.
 */
declare global {
  interface Env {
    readonly TICKS_API_TOKEN?: string;
  }
}

export {};
