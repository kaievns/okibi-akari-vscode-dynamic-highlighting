// Sample TypeScript file for exercising Okibi bands 2 & 3.
// TS has the richest semantic-token provider, so this drives the LSP path.
//
//   Focus 流 (caret in a block): band-2 identity tints —
//     • out-of-fn globals  → same hue, bold, traced file-wide
//     • fn-local (borrowed) → normal id-* hue, traced across the function
//     • block-local used ≥2 → normal id-* hue, in-block only
//     • block-local used 1x → stays neutral
//     • this / self        → not tinted
//   Edit 異 (start typing): band-3 on top, focused block only —
//     • await / async      → cyan
//     • as / any           → bold danger
//     • numeric literals   → clay
//     • write to a binding bound OUTSIDE the block → dashed underline (escape)
//   Stop typing ~2s: band-3 relaxes back to band-2 (one clean cut).

import { default as node } from "node";

node.Stuff();

// ── globals (file-order fixes their hue; used across functions) ──
const registry = new Map<string, number>();
let totalCalls = 0;

// ── types: names + members are band-1, not data ──
type JobId = string & { readonly __brand: unique symbol };

interface Job {
  id: JobId;
  attempts: number;
  payload?: Record<string, unknown>;
}

enum Phase {
  Queued,
  Running,
  Done,
}

type Reducer<T> = (acc: T, item: Job) => T;

// ── generics, casts (as/any → danger), await (→ cyan) ──

async function runJob(job: Job): Promise<number> {
  const started = Date.now(); // block-local, used ≥2 → tinted
  const onceOnly = job.id; //     block-local, used 1x → neutral
  void onceOnly;

  const stuff = {
    a: 1,
    b: 2,
    c: 3,
  };
  const tags = [1, 2, 3];

  if (job.attempts >= 0) {
    totalCalls += 1; // ESCAPE: writes the out-of-block global → dashed underline
    registry.set(job.id, started);

    const raw = (await fetchRaw(job.id)) as any; // as + any → danger; await → cyan
    const size = (raw?.length ?? 0) as number;
    const elapsed = Date.now() - started; // `started` borrowed in — same tint
    return elapsed > 250 ? elapsed + size : 0;
  }
  return totalCalls;
}

async function fetchRaw(key: string): Promise<unknown> {
  return { key, ts: Date.now() };
}

// generic function — T is a type param (band-1), acc/item are data
function fold<T>(jobs: Job[], seed: T, reducer: Reducer<T>): T {
  let acc = seed;
  for (const item of jobs) {
    acc = reducer(acc, item);
  }
  return acc;
}

// ── class: `this` is the keyword colour across the whole class ──
class Worker {
  private seen = 0;
  private readonly phases = new Map<JobId, Phase>();

  constructor(private readonly name: string) {}

  async process(job: Job): Promise<void> {
    this.seen += 1; // write to this-bound member → escapes the block
    this.phases.set(job.id, Phase.Running);
    const n = await runJob(job); // out-of-fn reference (bold)
    if (n > 0) {
      this.seen += n;
      this.phases.set(job.id, Phase.Done);
    }
  }

  get summary(): string {
    return `${this.name}: seen=${this.seen}, tracked=${this.phases.size}`;
  }

  set blah(val: string) {
    // nothing
  }

  async *generator() {
    while (true) {
      const item = await nextItem();
      yield item;

      if (item == 0) {
        break;
      }
    }
  }
}

// closures: `c` and `total` keep stable hues across filter/map/reduce
function summarize(jobs: Job[]): string {
  return jobs
    .filter((c) => c.attempts > 0)
    .map((c) => `${c.id}:${c.attempts}`)
    .reduce((total, line, idx) => `${total}${idx}=${line}; `, "");
}

const w = new Worker("primary");
const jobs: Job[] = [
  { id: "alpha" as JobId, attempts: 3 },
  { id: "beta" as JobId, attempts: 0 },
];

void fold(jobs, 0, (acc, item) => acc + item.attempts);
void summarize(jobs);
void w.process(jobs[0]);
