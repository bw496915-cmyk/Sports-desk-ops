/**
 * @file src/lib/rbac_scope.ts
 * @description Request-scoped RBAC context, modeled on the AsyncLocalStorage
 * pattern already used by `lib/inspect_redactor.ts`.
 *
 * A scope is opaque caller data attached to the current async context. Timers,
 * promises, and nested scopes inherit it through AsyncLocalStorage; the module
 * never retains a scope after its run callback and async resources finish.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface RbacScope {
  readonly actorId: string;
  readonly roles: readonly string[];
  /**
   * Opaque caller-supplied data scoped to the request. This module does not
   * inspect, log, or serialize it; it exists so callers can attach values that
   * must not outlive the scope.
   */
  readonly metadata?: unknown;
}

const rbacStore = new AsyncLocalStorage<RbacScope>();

/** The scope for the current async context, or undefined outside one. */
export function currentRbacScope(): RbacScope | undefined {
  return rbacStore.getStore();
}

/** Run `fn` with `scope` as the current RBAC scope; the previous scope is restored after. */
export function runWithRbacScope<T>(scope: RbacScope, fn: () => T): T {
  return rbacStore.run(scope, fn);
}
