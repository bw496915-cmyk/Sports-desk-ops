/**
 * @file lib/state_machine.ts
 * @description Explicit finite-state machine primitives with exhaustive transition tables,
 * discriminated-union state snapshots, fail-closed transition errors, and monotonic
 * generation tokens for fencing asynchronous continuations across lifecycle boundaries.
 */

export const ERR_INVALID_STATE_TRANSITION = "ERR_INVALID_STATE_TRANSITION";

export interface StateTransitionErrorDetails<S extends string = string> {
  readonly machine: string;
  readonly from: S;
  readonly to: S;
  readonly allowed: readonly S[];
  readonly event?: string | undefined;
}

/**
 * Thrown when a state machine attempts a transition not permitted by its transition table.
 * Never swallows invalid transitions silently (Signal Honesty: failures name their cause).
 */
export class StateTransitionError<S extends string = string> extends Error {
  readonly code = ERR_INVALID_STATE_TRANSITION;
  readonly details: StateTransitionErrorDetails<S>;

  constructor(details: StateTransitionErrorDetails<S>) {
    const via = details.event !== undefined ? ` on "${details.event}"` : "";
    const allowedText =
      details.allowed.length > 0 ? details.allowed.join(", ") : "(terminal)";
    super(
      `[${details.machine}] invalid state transition "${details.from}" -> "${details.to}"${via}; allowed from "${details.from}": ${allowedText}`,
    );
    this.name = "StateTransitionError";
    this.details = details;
  }
}

export type StateTransitionTable<S extends string> = Readonly<
  Record<S, readonly S[]>
>;

export interface DefinedStateGraph<S extends string> {
  readonly name: string;
  readonly states: readonly S[];
  readonly transitions: StateTransitionTable<S>;
  canTransition(from: S, to: S): boolean;
  assertTransition(from: S, to: S, event?: string): void;
}

/**
 * Declares and freezes an explicit state graph. Validates at definition time that every
 * state has a transition row and every target state belongs to `states`.
 */
export function defineStateGraph<const States extends readonly string[]>(
  name: string,
  states: States,
  transitions: StateTransitionTable<States[number]>,
): DefinedStateGraph<States[number]> {
  type S = States[number];
  const known = new Set<string>(states);
  const frozenRows = {} as Record<S, readonly S[]>;

  for (const state of states) {
    const s = state as S;
    const row = transitions[s];
    if (!Array.isArray(row)) {
      throw new Error(
        `[${name}] state "${String(s)}" has no transition row in table`,
      );
    }
    for (const target of row) {
      if (!known.has(target)) {
        throw new Error(
          `[${name}] transition "${String(s)}" -> "${String(target)}" targets unknown state`,
        );
      }
    }
    frozenRows[s] = Object.freeze([...row]);
  }

  const frozenStates = Object.freeze([...states]) as readonly S[];
  const frozenTable = Object.freeze(frozenRows) as StateTransitionTable<S>;

  return Object.freeze({
    name,
    states: frozenStates,
    transitions: frozenTable,
    canTransition(from: S, to: S): boolean {
      const allowed = frozenTable[from];
      return allowed !== undefined && allowed.includes(to);
    },
    assertTransition(from: S, to: S, event?: string): void {
      const allowed = frozenTable[from] ?? [];
      if (!allowed.includes(to)) {
        throw new StateTransitionError<S>({
          machine: name,
          from,
          to,
          allowed,
          event,
        });
      }
    },
  });
}

export interface TransitionEvent<Snapshot extends { readonly kind: string }> {
  readonly previous: Snapshot;
  readonly next: Snapshot;
  readonly generation: number;
  readonly event?: string | undefined;
}

export interface CreateStateMachineOptions<
  Snapshot extends { readonly kind: string },
> {
  readonly graph: DefinedStateGraph<Snapshot["kind"]>;
  readonly initial: Snapshot;
  readonly onTransition?: (change: TransitionEvent<Snapshot>) => void;
}

export interface ExplicitStateMachine<
  Snapshot extends { readonly kind: string },
> {
  readonly graph: DefinedStateGraph<Snapshot["kind"]>;
  /** Current discriminated-union state snapshot. */
  readonly state: Snapshot;
  /** Shorthand for `state.kind`. */
  readonly kind: Snapshot["kind"];
  /**
   * Monotonically increasing epoch incremented on every state transition (and via `fence()`).
   * Capture before an `await` and check `isCurrent(gen)` afterwards to discard stale work.
   */
  readonly generation: number;
  canTransitionTo(to: Snapshot["kind"]): boolean;
  isCurrent(capturedGeneration: number): boolean;
  /** Advance generation without changing `kind` (invalidates in-flight async work). */
  fence(): number;
  /** Validate `state.kind -> next.kind` against `graph`, update `state`, and bump `generation`. */
  transition<Next extends Snapshot>(next: Next, event?: string): Next;
}

/**
 * Instantiates an explicit state machine backed by a `DefinedStateGraph` and a
 * discriminated-union `Snapshot` whose `kind` matches the graph's state vocabulary.
 */
export function createStateMachine<Snapshot extends { readonly kind: string }>(
  options: CreateStateMachineOptions<Snapshot>,
): ExplicitStateMachine<Snapshot> {
  const { graph, onTransition } = options;
  if (!graph.states.includes(options.initial.kind)) {
    throw new Error(
      `[${graph.name}] unknown initial state "${options.initial.kind}"`,
    );
  }

  let current: Snapshot = options.initial;
  let gen = 0;

  return {
    graph,
    get state(): Snapshot {
      return current;
    },
    get kind(): Snapshot["kind"] {
      return current.kind;
    },
    get generation(): number {
      return gen;
    },
    canTransitionTo(to: Snapshot["kind"]): boolean {
      return graph.canTransition(current.kind, to);
    },
    isCurrent(capturedGeneration: number): boolean {
      return gen === capturedGeneration;
    },
    fence(): number {
      gen += 1;
      return gen;
    },
    transition<Next extends Snapshot>(next: Next, event?: string): Next {
      graph.assertTransition(current.kind, next.kind, event);
      const previous = current;
      current = next;
      gen += 1;
      onTransition?.({ previous, next, generation: gen, event });
      return next;
    },
  };
}
