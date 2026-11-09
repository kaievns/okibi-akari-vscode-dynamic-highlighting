'use strict';
// Linearity checks: this thread's CPU time, best of 3, so other processes' load does
// not count. Why not wall-clock bounds: docs/testing.md#timing.

const cpu = process.threadCpuUsage ? () => process.threadCpuUsage() : () => process.cpuUsage();

/** Best-of-3 CPU ms of `run(setup())`; `setup` is not timed. */
function cpuMs(setup, run) {
  let best = Infinity;
  for (let r = 0; r < 3; r++) {
    const input = setup();
    const t0 = cpu();
    run(input);
    const d = process.threadCpuUsage ? process.threadCpuUsage(t0) : process.cpuUsage(t0);
    best = Math.min(best, (d.user + d.system) / 1000);
  }
  return best;
}

/** CPU cost of `sizeOf(8n)` over `sizeOf(n)`, with a floor so a sub-50 µs small run cannot inflate it. */
function growth(setupFor, run, n) {
  cpuMs(() => setupFor(n), run); // warm the JIT on the shape first
  return cpuMs(() => setupFor(8 * n), run) / Math.max(cpuMs(() => setupFor(n), run), 0.05);
}

module.exports = { cpuMs, growth };
