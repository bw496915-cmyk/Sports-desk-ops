/** @typedef {{ phase: string; workDirty: boolean; strategy: string; genBehavior: string; onDisk: string; matchesHead: boolean; manifestOk: boolean; strictGate: boolean }} V */

export const title = "gen:tokens:gate (zero-drift CI check)";

export const colors = {
  Setup: "blue",
  Reset: "yellow",
  Outcome: "teal",
};

/** @param {V} v */
export const group = (v) => {
  if (v.phase === "Waiting to run") return "Setup";
  if (v.phase.startsWith("Reset")) return "Reset";
  return "Outcome";
};

/** @param {V} v */
export const state = (v) => v.phase;

/** @param {string} action @param {V} _from @param {V} to */
export const step = (action, _from, to) => {
  if (action === "RunGateDirty") {
    return "gate sees dirty generated files [local WIP]";
  }
  if (action === "RunGateCleanCheckout") {
    return "gate restores committed files (git checkout)";
  }
  if (action === "RunGateCleanRm") {
    return "gate deletes generated files (rm -f)";
  }
  if (action === "GenCrash") {
    return "gen:tokens exits with an error";
  }
  if (action === "GenSkipAfterRm") {
    return "gen:tokens finishes without writing a file";
  }
  if (action === "GenSkipStrict") {
    return "gen:tokens aborts under GEN_TOKENS_GATE (partial emit)";
  }
  if (action === "GenSkipAfterCheckout") {
    return "gen:tokens skips a file; manifest check fails (legacy weak gate)";
  }
  if (action === "ManifestForged") {
    return "manifest missing path or stale sha256 vs disk";
  }
  if (action === "GenDrift") {
    return "gen:tokens writes bytes that differ from HEAD";
  }
  if (action === "GenOk") {
    return "gen:tokens reproduces committed output";
  }
  if (action === "Done") return null;
  if (to.phase === "Gate passed" && to.genBehavior === "gen skips file") {
    return "gate reports clean [gen skipped write]";
  }
  return action;
};
