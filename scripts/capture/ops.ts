/**
 * Request planning for allowlisted capture operations.
 *
 * Live capture prefers the request body published in `docs/openapi.json`; where
 * the spec has no usable body (or publishes only an opaque schema), it falls
 * back to the observed Manager envelope from the runbooks. The one fully
 * observed request — `getWebLog` mode B — is pinned field-for-field.
 *
 * Credentials never live here. Values come from `F402_*` env vars at run time
 * (`resolveCaptureVars`) and are only ever placed into a request, never logged.
 */

import {
  opOperationId,
  opPath,
  READ_ONLY_OPS,
  type ReadOnlyOp,
} from "./allowlist.ts";
import { isPlainObject } from "./json.ts";
import { redactUrlForLog } from "./redact.ts";
import type { Env, HttpMethod, OperationRef } from "./types.ts";

export class RequestPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestPlanError";
  }
}

export interface CaptureVars {
  agentID: string;
  agentOwner: string;
  customerID: string;
  /** MM/DD/YYYY (mode B and most Manager forms). */
  date: string;
  /** YYYY-MM-DD (mode C reportedly uses this). */
  isoDate: string;
  ip: string;
}

export interface PlannedRequest {
  operation: OperationRef;
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  contentType: string;
  body: string | null;
}

export interface ObservedOpTemplate {
  contentType: string;
  headers: Record<string, string>;
  /** Ordered form fields (insertion order is the observed wire order). */
  form?: Record<string, string>;
  json?: unknown;
}

const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded; charset=UTF-8";
const JSON_CONTENT_TYPE = "application/json";

const COMMON_HEADERS: Record<string, string> = {
  accept: "application/json",
  "x-requested-with": "XMLHttpRequest",
};

/**
 * Manager wire templates. `getWebLog` reproduces the 2026-10-28 HAR mode-B
 * request exactly (field order included). The other Manager calls follow the
 * same observed envelope (agentID/agentOwner/operation/RRO) because only the
 * `getWebLog` body was captured; a live run is what settles them.
 */
export const OBSERVED_OP_TEMPLATES: Record<ReadOnlyOp, ObservedOpTemplate> = {
  getWebLog: {
    contentType: FORM_CONTENT_TYPE,
    headers: { ...COMMON_HEADERS },
    form: {
      agentID: "{agentID}",
      customerID: "0",
      start: "{date}",
      end: "{date}",
      type: "B",
      actions: "ALL",
      ip: "",
      operation: "getWebLog",
      RRO: "1",
      agentOwner: "{agentOwner}",
    },
  },
  getInfoPlayer: {
    contentType: FORM_CONTENT_TYPE,
    headers: { ...COMMON_HEADERS },
    form: {
      agentID: "{agentID}",
      customerID: "{customerID}",
      operation: "getInfoPlayer",
      // Runbook: RRO is 1 on reports and 0 on getInfoPlayer.
      RRO: "0",
      agentOwner: "{agentOwner}",
    },
  },
  getBetTicker: {
    contentType: FORM_CONTENT_TYPE,
    headers: { ...COMMON_HEADERS },
    form: {
      agentID: "{agentID}",
      agentOwner: "{agentOwner}",
      wagerNumber: "0",
      operation: "getBetTicker",
      RRO: "1",
    },
  },
  getBetTickerConfig: {
    contentType: FORM_CONTENT_TYPE,
    headers: { ...COMMON_HEADERS },
    form: {
      agentID: "{agentID}",
      operation: "getBetTickerConfig",
      RRO: "1",
      agentOwner: "{agentOwner}",
    },
  },
  getPending: {
    // The spec claims a JSON {customerID, date} body; every observed Manager
    // call is form-urlencoded. Capture settles the dispute, so plan the form
    // envelope (the only transport actually observed for this portal).
    contentType: FORM_CONTENT_TYPE,
    headers: { ...COMMON_HEADERS },
    form: {
      agentID: "{agentID}",
      agentOwner: "{agentOwner}",
      customerID: "{customerID}",
      operation: "getPending",
      RRO: "1",
    },
  },
  getSportsVigSetup: {
    contentType: FORM_CONTENT_TYPE,
    headers: { ...COMMON_HEADERS },
    form: {
      agentID: "{agentID}",
      operation: "getSportsVigSetup",
      RRO: "1",
      agentOwner: "{agentOwner}",
    },
  },
  getInfoManager: {
    contentType: FORM_CONTENT_TYPE,
    headers: { ...COMMON_HEADERS },
    form: {
      agentID: "{agentID}",
      operation: "getInfoManager",
      RRO: "1",
      agentOwner: "{agentOwner}",
    },
  },
  getCustomerNotes: {
    contentType: FORM_CONTENT_TYPE,
    headers: { ...COMMON_HEADERS },
    form: {
      agentID: "{agentID}",
      operation: "getCustomerNotes",
      customerID: "{customerID}",
      RRO: "1",
      agentOwner: "{agentOwner}",
    },
  },
};

/** Strip a trailing slash and validate an absolute http(s) base URL. */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new RequestPlanError("F402_BASE_URL is empty");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new RequestPlanError(
      `F402_BASE_URL is not an absolute URL (${redactUrlForLog(trimmed)})`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new RequestPlanError(
      `F402_BASE_URL must be http(s) (got ${url.protocol})`,
    );
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new RequestPlanError(
      "F402_BASE_URL must not embed credentials; use F402_AGENT_ID/F402_PASSWORD",
    );
  }
  return url.origin;
}

export function hostOf(baseUrl: string): string {
  return new URL(baseUrl).host;
}

export function formatMmDdYyyy(date: Date): string {
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${month}/${day}/${date.getUTCFullYear()}`;
}

export function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Capture plan values from the environment. Credentials are intentionally not
 * part of this type: only identity/date values needed to shape a read request.
 */
export function resolveCaptureVars(env: Env, now: Date): CaptureVars {
  const agentID = env["F402_AGENT_ID"]?.trim() ?? "";
  const agentOwner = env["F402_AGENT_OWNER"]?.trim();
  const customerID = env["F402_CUSTOMER_ID"]?.trim();
  const ip = env["F402_CAPTURE_IP"]?.trim();
  const captureDate = env["F402_CAPTURE_DATE"]?.trim();
  let date = formatMmDdYyyy(now);
  let isoDate = formatIsoDate(now);
  if (captureDate !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(captureDate)) {
    const parsed = new Date(`${captureDate}T00:00:00.000Z`);
    if (!Number.isNaN(parsed.getTime())) {
      date = formatMmDdYyyy(parsed);
      isoDate = formatIsoDate(parsed);
    }
  }
  return {
    agentID,
    agentOwner:
      agentOwner !== undefined && agentOwner.length > 0 ? agentOwner : agentID,
    customerID:
      customerID !== undefined && customerID.length > 0 ? customerID : "0",
    date,
    isoDate,
    ip: ip ?? "",
  };
}

/** Render `{token}` placeholders in one template value. */
export function renderTemplateValue(value: string, vars: CaptureVars): string {
  return value.replace(/\{([a-zA-Z]+)\}/g, (match, token: string) => {
    switch (token) {
      case "agentID":
        return vars.agentID;
      case "agentOwner":
        return vars.agentOwner;
      case "customerID":
        return vars.customerID;
      case "date":
        return vars.date;
      case "isoDate":
        return vars.isoDate;
      case "ip":
        return vars.ip;
      default:
        return match;
    }
  });
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

/** Build a request from the observed template for one allowlisted op. */
export function buildRequestFromTemplate(
  op: ReadOnlyOp,
  baseUrl: string,
  vars: CaptureVars,
): PlannedRequest {
  const template = OBSERVED_OP_TEMPLATES[op];
  let body: string | null = null;
  if (template.form !== undefined) {
    const params = new URLSearchParams();
    for (const [key, rawValue] of Object.entries(template.form)) {
      params.set(key, renderTemplateValue(rawValue, vars));
    }
    body = params.toString();
  } else if (template.json !== undefined) {
    body = JSON.stringify(template.json);
  }
  const headers: Record<string, string> = {
    ...template.headers,
    "content-type": template.contentType,
  };
  return {
    operation: {
      path: opPath(op),
      method: "POST",
      operationId: opOperationId(op),
    },
    url: joinUrl(baseUrl, opPath(op)),
    method: "POST",
    headers,
    contentType: template.contentType,
    body,
  };
}

// ---------------------------------------------------------------------------
// OpenAPI request-body resolution
// ---------------------------------------------------------------------------

interface SpecOperation {
  requestBody?: unknown;
}

/** Locate one operation in an already-parsed OpenAPI document. */
export function findSpecOperation(
  document: unknown,
  path: string,
  method: HttpMethod,
): SpecOperation | null {
  if (!isPlainObject(document)) return null;
  const paths = document["paths"];
  if (!isPlainObject(paths)) return null;
  const pathItem = paths[path];
  if (!isPlainObject(pathItem)) return null;
  const operation = pathItem[method.toLowerCase()];
  if (!isPlainObject(operation)) return null;
  return operation.requestBody === undefined
    ? {}
    : { requestBody: operation.requestBody };
}

interface FormField {
  name: string;
  value: string;
}

/**
 * Build a request body from the spec's form/JSON schema when it publishes real
 * fields, otherwise return null so the caller falls back to the template.
 * The observed mode-B value for `getWebLog.type` is pinned to "B" regardless of
 * what an example or enum would suggest.
 */
export function buildBodyFromSpec(
  op: ReadOnlyOp,
  spec: SpecOperation,
  vars: CaptureVars,
): { contentType: string; body: string } | null {
  const requestBody = spec.requestBody;
  if (!isPlainObject(requestBody)) return null;
  const content = requestBody["content"];
  if (!isPlainObject(content)) return null;

  const form = content["application/x-www-form-urlencoded"];
  if (isPlainObject(form)) {
    const fields = extractFields(form["schema"], op, vars);
    if (fields !== null && fields.length > 0) {
      const params = new URLSearchParams();
      for (const field of fields) params.set(field.name, field.value);
      return { contentType: FORM_CONTENT_TYPE, body: params.toString() };
    }
  }
  const json = content["application/json"];
  if (isPlainObject(json)) {
    const fields = extractFields(json["schema"], op, vars);
    if (fields !== null && fields.length > 0) {
      const object: Record<string, string> = {};
      for (const field of fields) object[field.name] = field.value;
      return { contentType: JSON_CONTENT_TYPE, body: JSON.stringify(object) };
    }
  }
  return null;
}

function extractFields(
  schema: unknown,
  op: ReadOnlyOp,
  vars: CaptureVars,
): FormField[] | null {
  if (!isPlainObject(schema)) return null;
  if (schema["type"] !== "object") return null;
  const properties = schema["properties"];
  if (!isPlainObject(properties)) return null;
  const fields: FormField[] = [];
  for (const name of Object.keys(properties)) {
    const candidate = properties[name];
    const fieldValue = valueForField(name, candidate, op, vars);
    if (fieldValue === null) {
      throw new RequestPlanError(
        `cannot plan required spec field "${name}" for ${op}: no observed value or example`,
      );
    }
    fields.push({ name, value: fieldValue });
  }
  const required = schema["required"];
  if (Array.isArray(required)) {
    for (const requiredName of required) {
      if (typeof requiredName !== "string") continue;
      if (!fields.some((field) => field.name === requiredName)) {
        throw new RequestPlanError(
          `spec field "${requiredName}" is required for ${op} but missing from planned body`,
        );
      }
    }
  }
  return fields;
}

function valueForField(
  name: string,
  schema: unknown,
  op: ReadOnlyOp,
  vars: CaptureVars,
): string | null {
  switch (name) {
    case "agentID":
      return vars.agentID;
    case "agentOwner":
      return vars.agentOwner;
    case "customerID":
      return vars.customerID;
    case "start":
    case "end":
      return op === "getWebLog" ? vars.date : vars.isoDate;
    case "ip":
      return vars.ip;
    case "type":
      if (op === "getWebLog") return "B";
      break;
    case "actions":
      return "ALL";
    case "operation":
      return op;
    case "RRO":
      return op === "getInfoPlayer" ? "0" : "1";
    default:
      break;
  }
  if (!isPlainObject(schema)) return null;
  const example = schema["example"];
  if (typeof example === "string" && example !== "<redacted>") return example;
  const enumValues = schema["enum"];
  if (Array.isArray(enumValues) && typeof enumValues[0] === "string") {
    return enumValues[0];
  }
  return null;
}

/**
 * Plan one live request: spec-derived body when available, observed template
 * otherwise. The Cookie header is added by the caller right before transport so
 * it never appears in any plan output.
 */
export function buildLiveRequest(
  op: ReadOnlyOp,
  baseUrl: string,
  vars: CaptureVars,
  openapi: unknown,
): PlannedRequest {
  const template = buildRequestFromTemplate(op, baseUrl, vars);
  const spec = findSpecOperation(openapi, opPath(op), "POST");
  if (spec === null) return template;
  const fromSpec = buildBodyFromSpec(op, spec, vars);
  if (fromSpec === null) return template;
  return {
    ...template,
    contentType: fromSpec.contentType,
    body: fromSpec.body,
    headers: { ...template.headers, "content-type": fromSpec.contentType },
  };
}

/** Plan requests for a run, in allowlist order. */
export function planRequests(
  ops: readonly ReadOnlyOp[],
  baseUrl: string,
  vars: CaptureVars,
  openapi: unknown,
): PlannedRequest[] {
  return ops.map((op) => buildLiveRequest(op, baseUrl, vars, openapi));
}

/** Login form configuration, all overridable because the portal markup is not contractual. */
export interface LoginConfig {
  loginUrl: string;
  userSelector: string;
  passSelector: string;
  submitSelector: string;
  /** IIFE (or expression) that resolves truthy once authenticated. */
  authenticatedExpression: string;
}

export const LOGIN_SELECTOR_DEFAULTS = {
  userSelector: 'input[name="customerID"]',
  passSelector: 'input[type="password"]',
  submitSelector: "button.btn.btn-primary",
} as const;

export function resolveLoginConfig(env: Env, baseUrl: string): LoginConfig {
  const loginPath = env["F402_LOGIN_PATH"]?.trim() ?? "/";
  const suffix = loginPath.startsWith("/") ? loginPath : `/${loginPath}`;
  return {
    loginUrl: `${baseUrl.replace(/\/$/, "")}${suffix}`,
    userSelector:
      env["F402_LOGIN_USER_SELECTOR"]?.trim() ??
      LOGIN_SELECTOR_DEFAULTS.userSelector,
    passSelector:
      env["F402_LOGIN_PASS_SELECTOR"]?.trim() ??
      LOGIN_SELECTOR_DEFAULTS.passSelector,
    submitSelector:
      env["F402_LOGIN_SUBMIT_SELECTOR"]?.trim() ??
      LOGIN_SELECTOR_DEFAULTS.submitSelector,
    authenticatedExpression:
      env["F402_AUTHENTICATED_EXPRESSION"]?.trim() ??
      '(() => ({ hasPasswordField: document.querySelector("input[type=password]") !== null, title: document.title, url: location.href }))()',
  };
}

/** Default ops for `--ops all`. Re-exported so the CLI has one source. */
export const DEFAULT_OPS: readonly ReadOnlyOp[] = READ_ONLY_OPS;
