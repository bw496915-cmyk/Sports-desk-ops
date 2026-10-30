# GenTokensGate

TLC reached 40 states and 40 steps. The chart draws 8 states and 10 arrows.
The view hides 16 steps, so the chart does not draw them.

## NoSilentPassWhenGenSkips breaks
The shortest path has 2 steps:
0. Waiting to run
1. gate restores committed files (git checkout): Reset files at HEAD
2. gen:tokens finishes without writing a file: Gate passed

## Rules that hold
TypeOK, DirtyGuardBlocks, NoPassAfterGenCrash, NoPassWhenFileMissing, PassImpliesMatchesHead, NoDeadlock
