/**
 * Band-2 colour assignment — spec "an ordering problem, not hashing".
 *
 * The palette was chosen by hand once (tokens.ts): six fn-local tints (--id-*,
 * normal weight), six out-of-fn tints (--idg-*, bold), one reserved gold slot
 * for this/self (--id-self, bold). Assignment walks a fixed interleaved slot
 * order so consecutive picks land >100° apart; it never hashes and never
 * recycles a hue.
 *
 * Salience ranking (assignment order):
 *   1. out-of-fn first, ordered by first appearance in the FILE (stability).
 *   2. then fn-local, ordered by first appearance in the BLOCK. No count floor.
 *   3. then block-local USED >= 2 times, by frequency desc then block order.
 *      Once-used block-locals stay neutral.
 *
 * Stability:
 *   - A global's colour is fixed by order of first appearance in the file and
 *     persisted in a per-document ledger, so it survives edits and focus
 *     changes (no shimmer). Overflow (>6 distinct globals) → neutral sentinel,
 *     never recycle.
 *   - fn-local / block-local / captures are assigned fresh per focus session
 *     from the rotation, skipping any slot pinned to a visible global.
 *     Deterministic given the session's name set, so a cache-hit revisit yields
 *     identical colours.
 */

import { NameInfo, Cls } from './classify';

/** Spec slot order; slot 2 is the reserved gold self-slot and never appears here. */
// Rotation order [1,3,2,7,5]: greedy max-hue-separation over the calibrated
// pool {kohaku 50°, gold 88°, fuji 285°, ayame 312°, akabeni 354°} — the 2-4
// tint prefix most blocks use stays maximally separated; the closest pair
// (ayame/akabeni, 42°) only appears when all five are in play.
export const INTERLEAVE = [1, 3, 2, 7, 5];

/** Zero-based index into the id[]/idg[] pools for each interleaved slot. */
const SLOT_TO_POOL_INDEX = INTERLEAVE.reduce<Record<number, number>>((acc, slot, i) => {
  acc[slot] = i;
  return acc;
}, {});

export type ColorPlanEntry =
  | { kind: 'id'; poolIndex: number }
  | { kind: 'idg'; poolIndex: number }
  | { kind: 'self' }
  | { kind: 'neutral' };

export type ColorPlan = Map<string, ColorPlanEntry>;

/**
 * Per-document ledger pinning each global (out-of-fn, non-capture) name to a
 * slot for the document's lifetime. `'overflow'` marks a name that appeared
 * after the six slots were spent — it stays neutral forever, never recycles.
 */
export class GlobalColorLedger {
  private slots = new Map<string, number | 'overflow'>();

  /** Slot already assigned to `name`, or undefined if never seen. */
  get(name: string): number | 'overflow' | undefined {
    return this.slots.get(name);
  }

  /** Set of interleave slots currently pinned to a global. */
  usedSlots(): Set<number> {
    const s = new Set<number>();
    for (const v of this.slots.values()) {
      if (v !== 'overflow') {
        s.add(v);
      }
    }
    return s;
  }

  /**
   * Assign the next free global slot to `name` (order of first appearance), or
   * record overflow. Idempotent: an already-pinned name keeps its slot.
   */
  assign(name: string): number | 'overflow' {
    const existing = this.slots.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const used = this.usedSlots();
    const free = INTERLEAVE.find((s) => !used.has(s));
    const result = free ?? 'overflow';
    this.slots.set(name, result);
    return result;
  }

  /**
   * Pin every global in file-appearance order, so a global's hue is fixed by
   * where it first appears in the FILE — not by which block the user happens to
   * focus first. Idempotent and monotonic: names already pinned keep their slot,
   * new names take the next free slot in the given order. Call before assigning
   * a block's visible globals.
   */
  seed(fileGlobalsInOrder: string[]): void {
    for (const name of fileGlobalsInOrder) {
      this.assign(name);
    }
  }

  drop(name: string): void {
    this.slots.delete(name);
  }
}

/**
 * Per-FUNCTION ledger pinning local data identities to hues, keyed by the
 * enclosing function so hues never leak between functions.
 *
 * Design: a variable must keep ONE hue across every sub-block of its function
 * (stability), but a function can hold far more locals than the 5-hue rotation —
 * they just never all appear in ONE block at once. So slots are a per-BLOCK
 * budget, not per-function: only the locals present in the currently focused
 * block compete for the 5 slots. A name remembers its slot (revisiting its block
 * keeps the colour), and a slot held by a name NOT in the current block is free
 * to reuse for a name that is — because sibling sub-blocks never coexist on
 * screen. This is what stops the last for-loop's `idx`/`n` from overflowing just
 * because earlier sub-blocks already spent the 5 slots.
 */
export class LocalColorLedger {
  private slots = new Map<string, number>();
  private key = '';

  /** Slot pinned to `name`, or undefined if it didn't get one this block. */
  get(name: string): number | undefined {
    return this.slots.get(name);
  }

  private ensureScope(fnKey: string): void {
    if (this.key !== fnKey) {
      this.key = fnKey;
      this.slots.clear();
    }
  }

  /**
   * Assign hues to `blockLocalsInOrder` — the locals present in the CURRENTLY
   * FOCUSED block, in function-appearance order. Each keeps its remembered slot
   * if it has one; new names take a slot not used by another name IN THIS BLOCK
   * (or reserved by a visible global). Names that can't fit (>5 in one block)
   * are left unassigned → neutral. Slots held by names outside this block are
   * fair game, so non-overlapping sub-blocks reuse the same 5 hues.
   */
  seed(fnKey: string, blockLocalsInOrder: string[], reserved: Set<number>): void {
    this.ensureScope(fnKey);

    // Slots already taken by names that ARE in this block (must not collide).
    const takenThisBlock = new Set<number>(reserved);
    for (const name of blockLocalsInOrder) {
      const s = this.slots.get(name);
      if (s !== undefined) {
        takenThisBlock.add(s);
      }
    }

    for (const name of blockLocalsInOrder) {
      if (this.slots.has(name)) {
        continue; // keep remembered hue (stability)
      }
      const free = INTERLEAVE.find((s) => !takenThisBlock.has(s));
      if (free === undefined) {
        continue; // >5 locals in one block → this one stays neutral
      }
      this.slots.set(name, free);
      takenThisBlock.add(free);
    }
  }
}

interface Ranked {
  name: string;
  info: NameInfo;
}

/** Salience buckets in assignment order. */
function rank(byName: Map<string, NameInfo>): { out: Ranked[]; fn: Ranked[]; block: Ranked[]; self: Ranked[] } {
  const out: Ranked[] = [];
  const fn: Ranked[] = [];
  const block: Ranked[] = [];
  const self: Ranked[] = [];

  for (const [name, info] of byName) {
    const r: Ranked = { name, info };
    switch (info.cls) {
      case 'self':
        self.push(r);
        break;
      case 'out':
        out.push(r);
        break;
      case 'fn':
        fn.push(r);
        break;
      case 'block':
        // USED >= 2 threshold; once-used block-locals stay neutral (excluded).
        if (info.freqInBlock >= 2) {
          block.push(r);
        }
        break;
    }
  }

  out.sort((a, b) => a.info.firstFileOffset - b.info.firstFileOffset);
  fn.sort((a, b) => a.info.firstBlockOffset - b.info.firstBlockOffset);
  block.sort((a, b) =>
    b.info.freqInBlock - a.info.freqInBlock || a.info.firstBlockOffset - b.info.firstBlockOffset,
  );

  return { out, fn, block, self };
}

/** Out-of-fn entries that are captures (declared in some other fn) — colour like locals. */
function capturesOf(out: Ranked[]): Ranked[] {
  return out.filter((r) => r.info.isCapture);
}

/** Inputs that scope colour stability. */
export interface AssignScope {
  /** Every true global in the file, first-appearance order (global hue stability). */
  fileGlobalsInOrder: string[];
  /** Local data identities in the enclosing function, first-appearance order (local hue stability). */
  fnLocalsInOrder: string[];
  /** True globals appearing in the enclosing function (their slots are reserved from locals). */
  fnGlobals: string[];
  /** Stable identity of the enclosing function, so the local ledger resets across functions. */
  fnKey: string;
}

/**
 * Produce the colour plan for the focused block. Two stability guarantees:
 *
 *  - GLOBAL hue is fixed by FILE first-appearance (`globalLedger`, document
 *    lifetime), so a global keeps its bold hue everywhere.
 *  - LOCAL hue is fixed by FUNCTION first-appearance (`localLedger`, keyed by
 *    `fnKey`), so a variable keeps ONE hue across every sub-block of its
 *    function — the caret moving from the body into an `if` or `for` never
 *    recolours it. This is the fix for "cfg goes purple → orange → white".
 *
 * Only names USED in the block are painted (`byName`), but their COLOUR comes
 * from the function-scoped ledger, not from block-order — that decoupling is
 * what makes navigation visually stable. Block-locals still need ≥2 uses in the
 * block to paint; once-used ones stay neutral (spec), but that gate no longer
 * affects any other name's hue.
 */
export function assignColors(
  byName: Map<string, NameInfo>,
  globalLedger: GlobalColorLedger,
  localLedger: LocalColorLedger,
  scope: AssignScope,
): ColorPlan {
  const plan: ColorPlan = new Map();
  const { out, fn, block, self } = rank(byName);

  // Global hues: seed all file globals in file order (navigation-independent).
  globalLedger.seed(scope.fileGlobalsInOrder);

  // Reserve the slots of globals that appear in THIS function, so local hues
  // keep >100° separation from the bold globals they sit beside.
  const reserved = new Set<number>();
  for (const g of scope.fnGlobals) {
    const s = globalLedger.get(g);
    if (typeof s === 'number') {
      reserved.add(s);
    }
  }

  // Local hues: seed only the locals PRESENT IN THIS BLOCK (fn-local, capture,
  // and block-local≥2 — the ones that will actually paint). Slots are a
  // per-block budget: sibling sub-blocks reuse the 5 hues, so a function with
  // many locals never overflows just because earlier blocks spent slots.
  //
  // When a block has MORE locals than hues, ATTENTION PRIORITY decides who wins
  // a slot (the deepest/closest data you're actually reading, then the most-used):
  //   1. proximity ascending — the focused block's OWN locals (0) beat borrowed-in
  //      (1) beat those declared in nested sub-blocks you're above (2).
  //   2. frequency descending — within a tier, the more-referenced name wins.
  //   3. function-appearance order — a stable final tiebreak so revisits and
  //      sibling blocks stay deterministic (no shimmer).
  const fnRank = new Map<string, number>();
  scope.fnLocalsInOrder.forEach((n, i) => fnRank.set(n, i));
  const candidates = [...fn, ...capturesOf(out), ...block];
  const blockLocals = candidates
    .slice()
    .sort(
      (a, b) =>
        a.info.proximity - b.info.proximity ||
        b.info.freqInBlock - a.info.freqInBlock ||
        (fnRank.get(a.name) ?? 1e9) - (fnRank.get(b.name) ?? 1e9),
    )
    .map((r) => r.name);
  localLedger.seed(scope.fnKey, blockLocals, reserved);

  // 1. self — always gold, never consumes a slot.
  for (const r of self) {
    plan.set(r.name, { kind: 'self' });
  }

  // 2. true globals → bold idg from the file-order ledger.
  for (const r of out) {
    if (r.info.isCapture) {
      continue; // captures are locals for colour purposes (declared in some fn)
    }
    const slot = globalLedger.assign(r.name);
    plan.set(
      r.name,
      slot === 'overflow' ? { kind: 'neutral' } : { kind: 'idg', poolIndex: SLOT_TO_POOL_INDEX[slot] },
    );
  }

  // 3. captures → bold idg, but hue from the local ledger.
  for (const r of capturesOf(out)) {
    const slot = localLedger.get(r.name);
    plan.set(
      r.name,
      slot === undefined ? { kind: 'neutral' } : { kind: 'idg', poolIndex: SLOT_TO_POOL_INDEX[slot] },
    );
  }

  // 4. fn-locals → normal id, hue from the local ledger.
  for (const r of fn) {
    const slot = localLedger.get(r.name);
    plan.set(
      r.name,
      slot === undefined ? { kind: 'neutral' } : { kind: 'id', poolIndex: SLOT_TO_POOL_INDEX[slot] },
    );
  }

  // 5. block-locals used ≥2 → normal id, hue from the local ledger.
  //    (Once-used block-locals were dropped by rank(); they stay neutral.)
  for (const r of block) {
    const slot = localLedger.get(r.name);
    plan.set(
      r.name,
      slot === undefined ? { kind: 'neutral' } : { kind: 'id', poolIndex: SLOT_TO_POOL_INDEX[slot] },
    );
  }

  return plan;
}

/**
 * Build the render plan for the focused block from a SCOPE COLOURING
 * (scopecolor.ts) — the two-pass model that replaces the stateful ledger.
 *
 *   - Which names paint: the block's visible set (pass 1, attention budget).
 *   - What hue: the co-visibility graph colour (pass 2, per colour scope).
 *   - Which tier: out-of-fn non-captures render bold (`idg`), everything else
 *     normal (`id`) — weight carries the local/global distinction now that both
 *     tiers share one tint set. self is never painted (band 1 owns it).
 *
 * Deterministic: no ledger, no navigation history. Same document → same plan.
 */
export function planFromColoring(
  classification: {
    focusKey: string;
    byName: Map<string, NameInfo>;
  },
  coloring: { hue: Map<string, number>; visible: Map<string, string[]> },
): ColorPlan {
  const plan: ColorPlan = new Map();
  const visible = coloring.visible.get(classification.focusKey) ?? [];

  for (const name of visible) {
    const info = classification.byName.get(name);
    if (!info || info.cls === 'self') {
      continue;
    }
    const poolIndex = coloring.hue.get(name);
    if (poolIndex === undefined) {
      plan.set(name, { kind: 'neutral' });
      continue;
    }
    // out-of-fn true globals are bold; captures are locals for weight purposes.
    const bold = info.cls === 'out' && !info.isCapture;
    plan.set(name, bold ? { kind: 'idg', poolIndex } : { kind: 'id', poolIndex });
  }

  return plan;
}

/** Convenience: which token-pool key does a plan entry map to (for the decoration pool). */
export function planEntryClass(entry: ColorPlanEntry): Cls | 'neutral' {
  switch (entry.kind) {
    case 'id':
      return 'fn';
    case 'idg':
      return 'out';
    case 'self':
      return 'self';
    default:
      return 'neutral';
  }
}
