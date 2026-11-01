/**
 * Manager customer-admin UI loads HTML partials via GET `?v=<bust>&async=<bool>`
 * (RequireJS). Most tab bodies use `async=true`; shared modal markup uses `async=false`
 * (e.g. player-info-modals.html).
 */

export const F402_CUSTOMER_ADMIN_MODULE_ROOT =
  "/app/ui/component/manager/module/customer-admin" as const;

/** Known partial filenames under {@link F402_CUSTOMER_ADMIN_MODULE_ROOT}. */
export const F402_CUSTOMER_ADMIN_PARTIALS = {
  header: "header.html",
  modalAgentList: "modal-agent-list.html",
  playerInfo: "player-info.html",
  playerInfoMeSetting: "player-info-me-setting.html",
  playerInfoModals: "player-info-modals.html",
  transactions: "transactions.html",
  performance: "performance.html",
} as const;

/** Default `async=` query for each registered partial when not overridden. */
export const F402_CUSTOMER_ADMIN_PARTIAL_ASYNC_DEFAULT: Partial<
  Record<CustomerAdminPartialKey, boolean>
> = {
  playerInfoModals: false,
};

export type CustomerAdminPartialKey = keyof typeof F402_CUSTOMER_ADMIN_PARTIALS;

export function resolveCustomerAdminPartialFile(idOrFile: string): string {
  const key = idOrFile as CustomerAdminPartialKey;
  if (key in F402_CUSTOMER_ADMIN_PARTIALS) {
    return F402_CUSTOMER_ADMIN_PARTIALS[key];
  }
  const trimmed = idOrFile.trim();
  if (trimmed.endsWith(".html")) return trimmed;
  return `${trimmed}.html`;
}

export interface CustomerAdminPartialUrlOptions {
  readonly bust?: number;
  /** RequireJS async load flag on the wire (`async=true` vs `async=false`). */
  readonly async?: boolean;
}

function resolvePartialAsyncDefault(
  idOrFile: string,
  file: string,
): boolean {
  const key = idOrFile as CustomerAdminPartialKey;
  if (key in F402_CUSTOMER_ADMIN_PARTIAL_ASYNC_DEFAULT) {
    return F402_CUSTOMER_ADMIN_PARTIAL_ASYNC_DEFAULT[key] ?? true;
  }
  for (const [k, filename] of Object.entries(F402_CUSTOMER_ADMIN_PARTIALS)) {
    if (filename === file) {
      return F402_CUSTOMER_ADMIN_PARTIAL_ASYNC_DEFAULT[k as CustomerAdminPartialKey] ?? true;
    }
  }
  return true;
}

/**
 * Chrome DevTools shape:
 * `GET /app/ui/component/manager/module/customer-admin/<file>?v=<bust>&async=<bool>`
 */
export function customerAdminPartialUrl(
  baseUrl: string,
  partialFile: string,
  options: CustomerAdminPartialUrlOptions = {},
): string {
  const file = resolveCustomerAdminPartialFile(partialFile);
  const bust = options.bust ?? Date.now();
  const asyncFlag =
    options.async ?? resolvePartialAsyncDefault(partialFile, file);
  const origin = new URL(baseUrl).origin;
  return `${origin}${F402_CUSTOMER_ADMIN_MODULE_ROOT}/${file}?v=${String(bust)}&async=${asyncFlag ? "true" : "false"}`;
}

/** @deprecated use {@link customerAdminPartialUrl} */
export function customerAdminAsyncPartialUrl(
  baseUrl: string,
  partialFile: string,
  bust: number = Date.now(),
): string {
  return customerAdminPartialUrl(baseUrl, partialFile, { bust, async: true });
}

/** Manager POST reads commonly fired from the player-info tab module. */
export const F402_PLAYER_INFO_TAB_OPERATIONS = new Set<string>([
  "getInfoPlayer",
  "getTeaserProfile",
  "getCryptoInfo",
  "getMail",
]);

/**
 * In-page GET for an async partial (session cookies + XHR headers).
 * Returns a Promise<{ status, bytes, contentType }>.
 */
export function buildLoadCustomerAdminPartialExpression(
  partialUrl: string,
): string {
  const url = JSON.stringify(partialUrl);
  return `(() => fetch(${url}, {
  credentials: "include",
  headers: { accept: "*/*", "x-requested-with": "XMLHttpRequest" },
}).then(async (r) => {
  const text = await r.text();
  return {
    status: r.status,
    bytes: text.length,
    contentType: r.headers.get("content-type") || "",
  };
}))()`;
}
