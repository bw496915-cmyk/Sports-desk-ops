---- MODULE GenTokensGate ----
\* Abstract model of scripts/gen_tokens_zero_drift_gate.sh (Sports-desk-ops).

EXTENDS FiniteSets

VARIABLES phase, workDirty, strategy, genBehavior, onDisk, matchesHead

vars == <<phase, workDirty, strategy, genBehavior, onDisk, matchesHead>>

Phases == {
  "Waiting to run",
  "Stopped dirty outputs",
  "Reset files at HEAD",
  "Reset files removed",
  "Generator failed",
  "Missing output file",
  "Output drift",
  "Gate passed",
  "Gate failed"
}

Strategies == {"checkout", "rm"}
GenBehaviors == {"regen ok", "gen crash", "gen skips file", "regen drift"}
DiskStates == {"at HEAD", "missing", "regenerated"}

TypeOK ==
  /\ phase \in Phases
  /\ workDirty \in BOOLEAN
  /\ strategy \in Strategies
  /\ genBehavior \in GenBehaviors
  /\ onDisk \in DiskStates
  /\ matchesHead \in BOOLEAN

Init ==
  /\ phase = "Waiting to run"
  /\ workDirty \in BOOLEAN
  /\ strategy \in Strategies
  /\ genBehavior \in GenBehaviors
  /\ onDisk = "at HEAD"
  /\ matchesHead = TRUE

Terminal ==
  phase \in {
    "Stopped dirty outputs",
    "Generator failed",
    "Missing output file",
    "Output drift",
    "Gate passed",
    "Gate failed"
  }

RunGateDirty ==
  /\ phase = "Waiting to run"
  /\ workDirty
  /\ phase' = "Stopped dirty outputs"
  /\ UNCHANGED <<workDirty, strategy, genBehavior, onDisk, matchesHead>>

RunGateCleanCheckout ==
  /\ phase = "Waiting to run"
  /\ ~workDirty
  /\ strategy = "checkout"
  /\ phase' = "Reset files at HEAD"
  /\ onDisk' = "at HEAD"
  /\ matchesHead' = TRUE
  /\ UNCHANGED <<workDirty, strategy, genBehavior>>

RunGateCleanRm ==
  /\ phase = "Waiting to run"
  /\ ~workDirty
  /\ strategy = "rm"
  /\ phase' = "Reset files removed"
  /\ onDisk' = "missing"
  /\ matchesHead' = FALSE
  /\ UNCHANGED <<workDirty, strategy, genBehavior>>

GenCrash ==
  /\ phase \in {"Reset files at HEAD", "Reset files removed"}
  /\ genBehavior = "gen crash"
  /\ phase' = "Generator failed"
  /\ UNCHANGED <<workDirty, strategy, genBehavior, onDisk, matchesHead>>

GenSkipAfterRm ==
  /\ phase = "Reset files removed"
  /\ genBehavior = "gen skips file"
  /\ phase' = "Missing output file"
  /\ UNCHANGED <<workDirty, strategy, genBehavior, onDisk, matchesHead>>

GenSkipAfterCheckout ==
  /\ phase = "Reset files at HEAD"
  /\ genBehavior = "gen skips file"
  /\ phase' = "Gate failed"
  /\ onDisk' = "at HEAD"
  /\ matchesHead' = TRUE
  /\ UNCHANGED <<workDirty, strategy, genBehavior>>

GenOk ==
  /\ phase \in {"Reset files at HEAD", "Reset files removed"}
  /\ genBehavior = "regen ok"
  /\ phase' = "Gate passed"
  /\ onDisk' = "regenerated"
  /\ matchesHead' = TRUE
  /\ UNCHANGED <<workDirty, strategy, genBehavior>>

GenDrift ==
  /\ phase \in {"Reset files at HEAD", "Reset files removed"}
  /\ genBehavior = "regen drift"
  /\ phase' = "Output drift"
  /\ onDisk' = "regenerated"
  /\ matchesHead' = FALSE
  /\ UNCHANGED <<workDirty, strategy, genBehavior>>

Done == Terminal /\ UNCHANGED vars

Next ==
  \/ RunGateDirty
  \/ RunGateCleanCheckout
  \/ RunGateCleanRm
  \/ GenCrash
  \/ GenSkipAfterRm
  \/ GenSkipAfterCheckout
  \/ GenOk
  \/ GenDrift
  \/ Done

Spec == Init /\ [][Next]_vars

DirtyGuardBlocks ==
  (workDirty /\ phase # "Waiting to run") => phase = "Stopped dirty outputs"

NoPassAfterGenCrash == ~(phase = "Gate passed" /\ genBehavior = "gen crash")

NoPassWhenFileMissing == ~(phase = "Gate passed" /\ onDisk = "missing")

PassImpliesMatchesHead == (phase = "Gate passed") => matchesHead

NoSilentPassWhenGenSkips == ~(phase = "Gate passed" /\ genBehavior = "gen skips file")

====
