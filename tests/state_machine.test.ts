import { describe, expect, test } from "bun:test";
import {
  createStateMachine,
  defineStateGraph,
  ERR_INVALID_STATE_TRANSITION,
  StateTransitionError,
} from "../lib/state_machine.ts";

type DemoState =
  | { readonly kind: "idle" }
  | { readonly kind: "connecting"; readonly attempt: number }
  | { readonly kind: "connected"; readonly sessionId: string }
  | { readonly kind: "closed"; readonly reason: string };

const DEMO_GRAPH = defineStateGraph(
  "DemoConnection",
  ["idle", "connecting", "connected", "closed"] as const,
  {
    idle: ["connecting", "closed"],
    connecting: ["connected", "idle", "closed"],
    connected: ["connecting", "closed"],
    closed: [],
  },
);

describe("explicit state machine primitives", () => {
  test("freezes states and transitions and validates allowed edges", () => {
    expect(Object.isFrozen(DEMO_GRAPH)).toBe(true);
    expect(Object.isFrozen(DEMO_GRAPH.states)).toBe(true);
    expect(Object.isFrozen(DEMO_GRAPH.transitions)).toBe(true);
    expect(DEMO_GRAPH.canTransition("idle", "connecting")).toBe(true);
    expect(DEMO_GRAPH.canTransition("idle", "connected")).toBe(false);
    expect(DEMO_GRAPH.canTransition("closed", "idle")).toBe(false);
  });

  test("rejects unknown target states when defining a graph", () => {
    expect(() =>
      defineStateGraph("Broken", ["a", "b"] as const, {
        a: ["c" as "b"],
        b: [],
      }),
    ).toThrow(/targets unknown state/);
  });

  test("tracks discriminated snapshots, increments generation, and emits transition events", () => {
    const history: string[] = [];
    const machine = createStateMachine<DemoState>({
      graph: DEMO_GRAPH,
      initial: { kind: "idle" },
      onTransition: ({ previous, next, generation, event }) => {
        history.push(
          `${generation}:${previous.kind}->${next.kind}:${event ?? "-"}`,
        );
      },
    });

    expect(machine.kind).toBe("idle");
    expect(machine.generation).toBe(0);
    expect(machine.isCurrent(0)).toBe(true);

    const connecting = machine.transition(
      { kind: "connecting", attempt: 1 },
      "dial",
    );
    expect(connecting).toEqual({ kind: "connecting", attempt: 1 });
    expect(machine.generation).toBe(1);
    expect(machine.isCurrent(0)).toBe(false);
    expect(machine.isCurrent(1)).toBe(true);

    machine.transition({ kind: "connected", sessionId: "s-1" }, "handshake_ok");
    expect(machine.state).toEqual({ kind: "connected", sessionId: "s-1" });
    expect(machine.generation).toBe(2);

    const fenced = machine.fence();
    expect(fenced).toBe(3);
    expect(machine.isCurrent(2)).toBe(false);
    expect(machine.isCurrent(3)).toBe(true);

    expect(history).toEqual([
      "1:idle->connecting:dial",
      "2:connecting->connected:handshake_ok",
    ]);
  });

  test("fails closed with StateTransitionError and preserves state on illegal transitions", () => {
    const machine = createStateMachine<DemoState>({
      graph: DEMO_GRAPH,
      initial: { kind: "idle" },
    });

    let caught: unknown;
    try {
      machine.transition({ kind: "connected", sessionId: "skip" }, "shortcut");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(StateTransitionError);
    const err = caught as StateTransitionError;
    expect(err.code).toBe(ERR_INVALID_STATE_TRANSITION);
    expect(err.details).toEqual({
      machine: "DemoConnection",
      from: "idle",
      to: "connected",
      allowed: ["connecting", "closed"],
      event: "shortcut",
    });
    expect(err.message).toContain(
      '[DemoConnection] invalid state transition "idle" -> "connected" on "shortcut"',
    );
    expect(machine.kind).toBe("idle");
    expect(machine.generation).toBe(0);

    machine.transition({ kind: "closed", reason: "shutdown" }, "stop");
    expect(() => machine.transition({ kind: "idle" })).toThrow(/\(terminal\)/);
  });
});
