// Sample TypeScript file for exercising Okibi bands 2 & 3.
// TS has the richest semantic-token provider, so this drives the LSP path.
//
//   Focus 流 (move caret into a block): band-2 identity tints appear —
//     • out-of-fn globals  → bold idg-* hue, traced file-wide
//     • fn-local (borrowed) → normal id-* hue, traced across the function
//     • block-local used ≥2 → normal id-* hue, in-block only
//     • block-local used 1x → stays neutral
//     • this / self        → gold, bold
//   Edit 異 (start typing):   band-3 risk marks add on top, focused block only —
//     • await / async      → cyan
//     • as / any           → bold danger
//     • numeric literals   → clay
//     • write to a binding bound OUTSIDE the block → dashed underline (escape)
//   Stop typing ~2s:        band-3 relaxes back to band-2 (one clean cut).

// ── true globals (file-order fixes their hue; used in multiple functions) ──
const registry = new Map<string, number>();
let totalCalls = 0;

interface Job {
  id: string;
  attempts: number;
}

async function runJob(job: Job): Promise<number> {
  // `job` is a fn-local (param), borrowed into the block below.
  // `registry` and `totalCalls` are out-of-fn globals (bold).
  const started = Date.now(); // block-local, used ≥2 → tinted
  const onceOnly = job.id; //     block-local, used 1x → neutral
  void onceOnly;

  if (job.attempts >= 0) {
    // ESCAPE: writing to the out-of-block global `totalCalls` gets a dashed underline.
    totalCalls += 1;
    registry.set(job.id, started);

    // band-3: await (cyan), `as`/`any` (danger), numbers (clay).
    const raw = (await fetchRaw(job.id)) as any;
    const elapsed = Date.now() - started; // `started` borrowed in — same tint as above
    return elapsed > 250 ? elapsed : 0;
  }
  return totalCalls;
}

async function fetchRaw(key: string): Promise<unknown> {
  return { key, ts: Date.now() };
}

class Worker {
  private seen = 0;

  // `this` inside the method block is the gold self-slot.
  async process(job: Job): Promise<void> {
    this.seen += 1; // write to `this`-bound member → escapes the block
    const n = await runJob(job); // `runJob` is an out-of-fn reference (bold)
    if (n > 0) {
      this.seen += n;
    }
  }
}

const w = new Worker();
void w.process({ id: "alpha", attempts: 3 });
