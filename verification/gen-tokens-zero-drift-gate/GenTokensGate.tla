---- MODULE GenTokensGate ----
\* Abstract model of scripts/gen_tokens_gate.ts + strict GEN_TOKENS_GATE manifest.

EXTENDS FiniteSets

VARIABLES phase, workDirty, strategy, genBehavior, onDisk, matchesHead, manifestOk, strictGate

vars == <<phase, workDirty, strategy, genBehavior, onDisk, matchesHead, manifestOk, strictGate>>

Phases == {
  "Waiting to run",
  "Stopped dirty outputs",
  "Reset files at HEAD",
  "Reset files removed",
  "Generator failed",
  "Manifest invalid",
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
  /\ manifestOk \in BOOLEAN
  /\ strictGate \in BOOLEAN

Init ==
  /\ phase = "Waiting to run"
  /\ workDirty \in BOOLEAN
  /\ strategy \in Strategies
  /\ genBehavior \in GenBehaviors
  /\ onDisk = "at HEAD"
  /\ matchesHead = TRUE
  /\ manifestOk = FALSE
  /\ strictGate = TRUE

Terminal ==
  phase \in {
    "Stopped dirty outputs",
    "Generator failed",
    "Manifest invalid",
    "Missing output file",
    "Output drift",
    "Gate passed",
    "Gate failed"
  }

RunGateDirty ==
  /\ phase = "Waiting to run"
  /\ workDirty
  /\ phase' = "Stopped dirty outputs"
  /\ UNCHANGED <<workDirty, strategy, genBehavior, onDisk, matchesHead, manifestOk, strictGate>>

RunGateCleanCheckout ==
  /\ phase = "Waiting to run"
  /\ ~workDirty
  /\ strategy = "checkout"
  /\ phase' = "Reset files at HEAD"
  /\ onDisk' = "at HEAD"
  /\ matchesHead' = TRUE
  /\ manifestOk' = FALSE
  /\ UNCHANGED <<workDirty, strategy, genBehavior, strictGate>>

RunGateCleanRm ==
  /\ phase = "Waiting to run"
  /\ ~workDirty
  /\ strategy = "rm"
  /\ phase' = "Reset files removed"
  /\ onDisk' = "missing"
  /\ matchesHead' = FALSE
  /\ manifestOk' = FALSE
  /\ UNCHANGED <<workDirty, strategy, genBehavior, strictGate>>

GenCrash ==
  /\ phase \in {"Reset files at HEAD", "Reset files removed"}
  /\ genBehavior = "gen crash"
  /\ phase' = "Generator failed"
  /\ UNCHANGED <<workDirty, strategy, genBehavior, onDisk, matchesHead, manifestOk, strictGate>>

GenSkipStrict ==
  /\ phase \in {"Reset files at HEAD", "Reset files removed"}
  /\ genBehavior = "gen skips file"
  /\ strictGate
  /\ phase' = "Generator failed"
  /\ UNCHANGED <<workDirty, strategy, genBehavior, onDisk, matchesHead, manifestOk, strictGate>>

GenSkipAfterRm ==
  /\ phase = "Reset files removed"
  /\ genBehavior = "gen skips file"
  /\ ~strictGate
  /\ phase' = "Missing output file"
  /\ UNCHANGED <<workDirty, strategy, genBehavior, onDisk, matchesHead, manifestOk, strictGate>>

GenSkipAfterCheckout ==
  /\ phase = "Reset files at HEAD"
  /\ genBehavior = "gen skips file"
  /\ ~strictGate
  /\ phase' = "Gate failed"
  /\ onDisk' = "at HEAD"
  /\ matchesHead' = TRUE
  /\ manifestOk' = FALSE
  /\ UNCHANGED <<workDirty, strategy, genBehavior, strictGate>>

GenOk ==
  /\ phase \in {"Reset files at HEAD", "Reset files removed"}
  /\ genBehavior = "regen ok"
  /\ phase' = "Gate passed"
  /\ onDisk' = "regenerated"
  /\ matchesHead' = TRUE
  /\ manifestOk' = TRUE
  /\ UNCHANGED <<workDirty, strategy, genBehavior, strictGate>>

GenDrift ==
  /\ phase \in {"Reset files at HEAD", "Reset files removed"}
  /\ genBehavior = "regen drift"
  /\ phase' = "Output drift"
  /\ onDisk' = "regenerated"
  /\ matchesHead' = FALSE
  /\ manifestOk' = TRUE
  /\ UNCHANGED <<workDirty, strategy, genBehavior, strictGate>>

ManifestForged ==
  /\ phase \in {"Reset files at HEAD", "Reset files removed"}
  /\ genBehavior = "regen ok"
  /\ strictGate
  /\ phase' = "Manifest invalid"
  /\ onDisk' = "at HEAD"
  /\ matchesHead' = TRUE
  /\ manifestOk' = FALSE
  /\ UNCHANGED <<workDirty, strategy, genBehavior, strictGate>>

Done == Terminal /\ UNCHANGED vars

Next ==
  \/ RunGateDirty
  \/ RunGateCleanCheckout
  \/ RunGateCleanRm
  \/ GenCrash
  \/ GenSkipStrict
  \/ GenSkipAfterRm
  \/ GenSkipAfterCheckout
  \/ GenOk
  \/ GenDrift
  \/ ManifestForged
  \/ Done

Spec == Init /\ [][Next]_vars

DirtyGuardBlocks ==
  (workDirty /\ phase # "Waiting to run") => phase = "Stopped dirty outputs"

NoPassAfterGenCrash == ~(phase = "Gate passed" /\ genBehavior = "gen crash")

NoPassWhenFileMissing == ~(phase = "Gate passed" /\ onDisk = "missing")

PassImpliesMatchesHead == (phase = "Gate passed") => matchesHead

NoSilentPassWhenGenSkips ==
  ~(phase = "Gate passed" /\ genBehavior = "gen skips file")

PassImpliesManifestOk == (phase = "Gate passed") => manifestOk

NoPassOnManifestInvalid == phase # "Gate passed" \/ manifestOk

====
