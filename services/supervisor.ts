#!/usr/bin/env bun
/**
 * Minimal process supervisor for the long-lived services.
 *
 * - Starts each service as a child, restarts it with capped exponential backoff on exit.
 * - Polls every service's `/health`; three consecutive failures kill and restart that child.
 * - Stops all children on SIGINT/SIGTERM; no orphan processes.
 *
 * The blob gateway is opt-in: without BLOB_API_TOKEN/BLOB_TICKET_SECRET it is not supervised, so a
 * checkout that has not provisioned R2 credentials still runs the daemon alone.
 */

import { env } from "bun";

import { resolveBunServePort } from "../lib/bun_serve_port.ts";
import { resolveSecretBackedEnv } from "../lib/r2_s3_client.ts";

export interface ServiceSpec {
  readonly name: string;
  readonly command: readonly string[];
  readonly healthUrl: string;
}

export type SupervisorKill = (signal?: "SIGTERM" | "SIGKILL") => void;

export interface SupervisorProcess {
  readonly pid: number;
  readonly exited: Promise<number>;
  readonly kill: SupervisorKill;
}

export interface SupervisorOptions {
  readonly services?: readonly ServiceSpec[];
  readonly healthIntervalMs?: number;
  readonly unhealthyThreshold?: number;
  readonly fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  readonly spawnImpl?: (command: readonly string[]) => SupervisorProcess;
  readonly noEnvFile?: boolean;
  readonly log?: (event: Record<string, unknown>) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Test/daemon hook: aborting stops children and resolves `supervise`. */
  readonly signal?: AbortSignal;
}

const HEALTH_INTERVAL_MS = 10_000;
const UNHEALTHY_THRESHOLD = 3;
const MAX_RESTART_DELAY_MS = 30_000;

function portFrom(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Service roster; the blob gateway appears only when its credentials are provisioned. */
export function supervisedServices(
  environment: Readonly<Record<string, string | undefined>> = env,
): readonly ServiceSpec[] {
  const webviewPort = resolveBunServePort(environment);
  if (webviewPort === 0) {
    throw new Error(
      "supervisor: webview port is 0 (random); set BUN_PORT, PORT or NODE_PORT to a fixed port",
    );
  }
  const blobPort = portFrom(environment, "BLOB_PORT", 4021);
  const services: ServiceSpec[] = [
    {
      name: "webview",
      command: ["bun", "run", "services/sportsdesk_webview_server.ts"],
      healthUrl:
        environment.WEBVIEW_HEALTH_URL ??
        `http://127.0.0.1:${webviewPort}/health`,
    },
  ];
  if (
    environment.BLOB_API_TOKEN !== undefined &&
    environment.BLOB_TICKET_SECRET !== undefined
  ) {
    services.push({
      name: "blob-live-bets",
      command: ["bun", "run", "services/blob_and_live_bets_server.ts"],
      healthUrl:
        environment.BLOB_HEALTH_URL ?? `http://127.0.0.1:${blobPort}/health`,
    });
  }
  return services;
}

/** Resolve the BLOB_* tokens from Bun.secrets when the environment has none. */
export async function supervisedServicesAsync(
  environment: Readonly<Record<string, string | undefined>> = env,
  secrets: Parameters<typeof resolveSecretBackedEnv>[1] = Bun.secrets,
): Promise<readonly ServiceSpec[]> {
  return supervisedServices(await resolveSecretBackedEnv(environment, secrets));
}

/** Capped exponential backoff: 1s, 2s, 4s … 30s. */
export function restartDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.min(5, attempt));
  return Math.min(MAX_RESTART_DELAY_MS, 1000 * 2 ** exponent);
}

export async function checkHealth(
  url: string,
  options: {
    readonly fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
    readonly timeoutMs?: number;
  } = {},
): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

import {
  createStateMachine,
  defineStateGraph,
  type ExplicitStateMachine,
} from "../lib/state_machine.ts";

export const SUPERVISOR_STATES = ["running", "stopping", "stopped"] as const;
export type SupervisorLifecycleKind = (typeof SUPERVISOR_STATES)[number];

export const SUPERVISOR_STATE_GRAPH = defineStateGraph(
  "SupervisorLifecycle",
  SUPERVISOR_STATES,
  {
    running: ["stopping"],
    stopping: ["stopped"],
    stopped: [],
  },
);

export type SupervisorLifecycleSnapshot =
  | { readonly kind: "running" }
  | { readonly kind: "stopping"; readonly signal: string }
  | { readonly kind: "stopped"; readonly signal: string };

export const SUPERVISED_CHILD_STATES = [
  "starting",
  "healthy",
  "degraded",
  "restarting_unhealthy",
  "backoff",
  "stopped",
] as const;
export type SupervisedChildStateKind = (typeof SUPERVISED_CHILD_STATES)[number];

export const SUPERVISED_CHILD_GRAPH = defineStateGraph(
  "SupervisedChild",
  SUPERVISED_CHILD_STATES,
  {
    starting: ["healthy", "degraded", "backoff", "stopped"],
    healthy: ["healthy", "degraded", "backoff", "stopped"],
    degraded: [
      "healthy",
      "degraded",
      "restarting_unhealthy",
      "backoff",
      "stopped",
    ],
    restarting_unhealthy: ["backoff", "stopped"],
    backoff: ["starting", "stopped"],
    stopped: [],
  },
);

export type SupervisedChildSnapshot =
  | {
      readonly kind: "starting";
      readonly process: SupervisorProcess;
      readonly restarts: number;
    }
  | {
      readonly kind: "healthy";
      readonly process: SupervisorProcess;
      readonly restarts: number;
    }
  | {
      readonly kind: "degraded";
      readonly process: SupervisorProcess;
      readonly restarts: number;
      readonly failures: number;
    }
  | {
      readonly kind: "restarting_unhealthy";
      readonly process: SupervisorProcess;
      readonly restarts: number;
    }
  | {
      readonly kind: "backoff";
      readonly restarts: number;
      readonly delayMs: number;
    }
  | {
      readonly kind: "stopped";
    };

interface SupervisedChildEntry {
  readonly spec: ServiceSpec;
  readonly machine: ExplicitStateMachine<SupervisedChildSnapshot>;
}

function activeChildProcess(
  snapshot: SupervisedChildSnapshot,
): SupervisorProcess | null {
  switch (snapshot.kind) {
    case "starting":
    case "healthy":
    case "degraded":
    case "restarting_unhealthy":
      return snapshot.process;
    case "backoff":
    case "stopped":
      return null;
  }
}

export async function supervise(
  options: SupervisorOptions = {},
): Promise<void> {
  const services = options.services ?? (await supervisedServicesAsync());
  const log =
    options.log ??
    ((event: Record<string, unknown>) => console.log(JSON.stringify(event)));
  const healthIntervalMs = options.healthIntervalMs ?? HEALTH_INTERVAL_MS;
  const threshold = options.unhealthyThreshold ?? UNHEALTHY_THRESHOLD;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const noEnvFile = options.noEnvFile ?? Bun.env.SUPERVISOR_NO_ENV_FILE === "1";
  const spawnImpl =
    options.spawnImpl ??
    ((command: readonly string[]): SupervisorProcess => {
      const [bin, ...rest] = command;
      const args =
        bin === undefined
          ? [...command]
          : [
              bin,
              "--no-orphans",
              ...(noEnvFile ? ["--no-env-file"] : []),
              ...rest,
            ];
      return Bun.spawn(args, { stdout: "inherit", stderr: "inherit" });
    });

  const supervisorMachine = createStateMachine<SupervisorLifecycleSnapshot>({
    graph: SUPERVISOR_STATE_GRAPH,
    initial: { kind: "running" },
  });
  let resolveFinished: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  const children: SupervisedChildEntry[] = [];
  const timers: ReturnType<typeof setInterval>[] = [];

  const attachExitWatcher = (
    entry: SupervisedChildEntry,
    proc: SupervisorProcess,
  ): void => {
    void proc.exited.then((code: number) => {
      if (supervisorMachine.kind !== "running") return;
      const current = entry.machine.state;
      if (current.kind === "stopped" || current.kind === "backoff") return;
      if (activeChildProcess(current) !== proc) return;

      const attempt = current.restarts;
      const nextRestarts = attempt + 1;
      const delay = restartDelayMs(attempt);
      entry.machine.transition(
        { kind: "backoff", restarts: nextRestarts, delayMs: delay },
        "process_exit",
      );
      const backoffGen = entry.machine.generation;
      log({
        event: "exit",
        service: entry.spec.name,
        code,
        restartInMs: delay,
      });

      void sleep(delay).then(() => {
        if (
          supervisorMachine.kind !== "running" ||
          !entry.machine.isCurrent(backoffGen)
        ) {
          return;
        }
        const respawned = spawnImpl(entry.spec.command);
        entry.machine.transition(
          {
            kind: "starting",
            process: respawned,
            restarts: nextRestarts,
          },
          "backoff_elapsed",
        );
        log({
          event: "restart",
          service: entry.spec.name,
          pid: respawned.pid,
        });
        attachExitWatcher(entry, respawned);
      });
    });
  };

  const start = (spec: ServiceSpec): SupervisedChildEntry => {
    const proc = spawnImpl(spec.command);
    const machine = createStateMachine<SupervisedChildSnapshot>({
      graph: SUPERVISED_CHILD_GRAPH,
      initial: { kind: "starting", process: proc, restarts: 0 },
    });
    const entry: SupervisedChildEntry = { spec, machine };
    log({
      event: "start",
      service: spec.name,
      pid: proc.pid,
      command: spec.command.join(" "),
    });
    attachExitWatcher(entry, proc);
    return entry;
  };

  const stop = (signal: string) => {
    if (supervisorMachine.kind !== "running") return;
    supervisorMachine.transition({ kind: "stopping", signal }, "shutdown");
    log({ event: "shutdown", signal });
    for (const timer of timers) clearInterval(timer);
    for (const entry of children) {
      const proc = activeChildProcess(entry.machine.state);
      if (entry.machine.kind !== "stopped") {
        entry.machine.transition({ kind: "stopped" }, "supervisor_stop");
      }
      if (proc !== null) {
        try {
          proc.kill("SIGTERM");
        } catch {
          // already gone
        }
      }
    }
    supervisorMachine.transition({ kind: "stopped", signal }, "stopped");
    resolveFinished();
  };
  const onSigInt = () => stop("SIGINT");
  const onSigTerm = () => stop("SIGTERM");
  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);
  options.signal?.addEventListener("abort", () => stop("abort"), {
    once: true,
  });
  if (options.signal?.aborted === true) stop("abort");

  try {
    if (supervisorMachine.kind === "running") {
      for (const spec of services) {
        const entry = start(spec);
        children.push(entry);
        timers.push(
          setInterval(() => {
            if (supervisorMachine.kind !== "running") return;
            const snapBefore = entry.machine.state;
            // Only probe live running/starting/degraded processes; never probe during backoff or restart kill.
            if (
              snapBefore.kind !== "starting" &&
              snapBefore.kind !== "healthy" &&
              snapBefore.kind !== "degraded"
            ) {
              return;
            }
            const probedProc = snapBefore.process;
            const probeGen = entry.machine.generation;
            void checkHealth(spec.healthUrl, { fetchImpl }).then((healthy) => {
              if (
                supervisorMachine.kind !== "running" ||
                !entry.machine.isCurrent(probeGen)
              ) {
                return;
              }
              const current = entry.machine.state;
              if (
                (current.kind !== "starting" &&
                  current.kind !== "healthy" &&
                  current.kind !== "degraded") ||
                current.process !== probedProc
              ) {
                return;
              }
              if (healthy) {
                entry.machine.transition(
                  {
                    kind: "healthy",
                    process: current.process,
                    restarts: 0,
                  },
                  "health_ok",
                );
                return;
              }
              const failures =
                current.kind === "degraded" ? current.failures + 1 : 1;
              entry.machine.transition(
                {
                  kind: "degraded",
                  process: current.process,
                  restarts: current.restarts,
                  failures,
                },
                "health_failed",
              );
              log({
                event: "unhealthy",
                service: spec.name,
                failures,
                healthUrl: spec.healthUrl,
              });
              if (failures >= threshold) {
                entry.machine.transition(
                  {
                    kind: "restarting_unhealthy",
                    process: current.process,
                    restarts: current.restarts,
                  },
                  "threshold_exceeded",
                );
                log({ event: "restart-unhealthy", service: spec.name });
                try {
                  current.process.kill("SIGTERM");
                } catch {
                  // already gone
                }
              }
            });
          }, healthIntervalMs),
        );
      }

      log({
        event: "supervising",
        services: services.map((spec) => ({
          name: spec.name,
          healthUrl: spec.healthUrl,
        })),
      });
    }
    await finished;
  } finally {
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
  }
}

if (import.meta.main) {
  await supervise().catch((error: unknown) => {
    console.error(
      `supervisor: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
