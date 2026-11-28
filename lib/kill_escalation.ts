/**
 * @file lib/kill_escalation.ts
 * @description SIGTERM -> SIGKILL escalation for a child-process handle.
 *
 * The helper takes the process handle (never a raw pid), marks itself exited when
 * the owner observes the child's exit, and checks that flag immediately before the
 * kill so a timer cannot signal a pid that has already been reaped.
 */

export interface EscalatableProcess {
  kill(signal: "SIGTERM" | "SIGKILL"): unknown;
}

export interface KillEscalationOptions {
  /** Delay between SIGTERM and SIGKILL. */
  readonly graceMs: number;
  /** Called once, just before SIGKILL, for audit/telemetry. */
  readonly onEscalate?: ((graceMs: number) => void) | undefined;
}

export interface KillEscalation {
  /** Send SIGTERM once, then SIGKILL after the grace period unless marked exited. */
  terminate(): void;
  /** The owner saw the child exit: cancel any pending SIGKILL. */
  markExited(): void;
  readonly escalated: boolean;
}

export function createKillEscalation(
  proc: EscalatableProcess,
  options: KillEscalationOptions,
): KillEscalation {
  if (!Number.isFinite(options.graceMs) || options.graceMs < 0) {
    throw new RangeError(
      `ERR_KILL_GRACE_INVALID: expected a non-negative finite number, got ${String(options.graceMs)}`,
    );
  }

  let exited = false;
  let termSent = false;
  let escalated = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    terminate(): void {
      if (exited || termSent) return;
      termSent = true;
      try {
        proc.kill("SIGTERM");
      } catch {
        // The child may have exited between the flag check and the signal.
      }
      timer = setTimeout(() => {
        timer = null;
        if (exited) return;
        escalated = true;
        options.onEscalate?.(options.graceMs);
        try {
          proc.kill("SIGKILL");
        } catch {
          // Same race as SIGTERM: a reaped child is already gone.
        }
      }, options.graceMs);
      (timer as unknown as { unref?: () => void }).unref?.();
    },

    markExited(): void {
      exited = true;
      clear();
    },

    get escalated(): boolean {
      return escalated;
    },
  };
}
