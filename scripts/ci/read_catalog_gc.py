"""Correlate user-mode marking samples with the catalog's normal parser progress."""
from pathlib import Path
import re
import sys


def read_phases(log, pid):
    # Collector.cpp emits the pause suffix immediately before Concurrent and
    # opens the next log record in runReloopPhase. Treat the transition edges
    # as uncertain. Bound a witness by JS progress *inside* the phase.
    pending = None
    windows = []
    phases = parsed = 0
    last_ms = 0
    for token in re.finditer(
        r"\)\.\.\.\]|\[GC<0x[0-9a-f]+>: [CM] |"
        r"catalog-parsed (\d+) pid=(\d+) wall_ms=(\d+)", log
    ):
        if token[1]:
            index, marker_pid, wall_ms = map(int, token.groups())
            if marker_pid != pid or index != parsed + 1 or wall_ms < last_ms:
                raise ValueError("Ambiguous parser progress or clock ordering")
            parsed, last_ms = index, wall_ms
            if pending is not None:
                pending.append(wall_ms)
        elif token[0].startswith("[GC"):
            if pending is None:
                raise ValueError("GC reloop without a concurrent phase")
            phases += 1
            if len(pending) >= 3:
                # The second clock read follows the first synchronous marker.
                # Round inward to account for Date.now()'s millisecond precision.
                windows.append(((pending[1] + 1) * 1_000_000, pending[-1] * 1_000_000))
            pending = None
        else:
            if pending is not None:
                raise ValueError("Nested concurrent phase")
            pending = []
    if pending is not None or not parsed:
        raise ValueError("Incomplete catalog trace")
    return parsed, phases, windows


def summarize(directory):
    log = (directory / "catalog.log").read_text()
    launches = re.findall(r"^catalog-process pid=(\d+) revision=38afee6c84fcf48c0edb2466aa4b27d287a59c30$", log, re.M)
    if len(launches) != 1 or "catalog fresh:" not in log or len(set(re.findall(r"\[GC<(0x[0-9a-f]+)>:", log))) != 1:
        raise ValueError("Expected one successfully completed catalog check on pinned Bun")
    pid = int(launches[0])
    parsed, phases, windows = read_phases(log, pid)
    samples = marking = concurrent = 0
    witness = None
    for line in (directory / "samples.txt").read_text().splitlines():
        match = re.match(r"\s*(\d+)[/\s]+(\d+)\s+(\d+)\.(\d{9}):\s+\w+\s+(.+)", line)
        if not match or int(match[1]) != pid:
            continue
        samples += 1
        symbol = match[5]
        if (int(match[2]) == pid or "(/usr/local/bin/bun)" not in symbol or
                not re.search(r"::visitChildren(?:Impl)?(?:<|\()|SlotVisitor::append\w*Slow\(", symbol)):
            continue
        marking += 1
        instant = int(match[3]) * 1_000_000_000 + int(match[4])
        if any(start < instant < end for start, end in windows):
            concurrent += 1
            witness = witness or line.strip()
    if not samples:
        raise ValueError("No CPU samples matched the catalog PID")
    print(f"PID {pid}: {parsed} files parsed, {phases} concurrent phases, {samples} process CPU samples.")
    print(f"Background visitor samples: {marking}; inside JS-bounded concurrent intervals: {concurrent}.")
    if witness:
        print(f"Concurrent marking observed. First witness: {witness}")
    else:
        print("Concurrent marking was not established by a sample inside a JS-bounded interval.")


if __name__ == "__main__":
    summarize(Path(sys.argv[1]))
