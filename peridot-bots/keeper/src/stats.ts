/** In-memory per-loop cycle counters, drained by the periodic Telegram report. */

interface LoopStats {
  ok: number;
  failed: number;
  cycles: number;
}

const counters = new Map<string, LoopStats>();

export function recordCycle(loop: string, ok: number, failed: number): void {
  const entry = counters.get(loop) ?? { ok: 0, failed: 0, cycles: 0 };
  entry.ok += ok;
  entry.failed += failed;
  entry.cycles += 1;
  counters.set(loop, entry);
}

export function snapshotAndReset(): Record<string, LoopStats> {
  const snapshot: Record<string, LoopStats> = {};
  for (const [loop, stats] of counters) {
    snapshot[loop] = { ...stats };
  }
  counters.clear();
  return snapshot;
}
