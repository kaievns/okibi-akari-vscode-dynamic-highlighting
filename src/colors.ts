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
export const INTERLEAVE = [1, 3, 4, 5, 6, 7];

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
 * Per-FUNCTION ledger pinning each local data identity (fn-local, block-local,
 * capture) to a slot for as long as that function stays the focus's enclosing
 * function. This is what makes a local's hue stable across every sub-block: the
 * colour is decided once, by first-appearance order in the function, and reused
 * whether the caret sits in the function body, an `if`, or a nested `for`.
 *
 * It is rebuilt when the enclosing function changes (keyed by the function's
 * offset span) so hues don't leak between unrelated functions, and it skips a
 * set of reserved slots (those held by globals visible in the function) to keep
 * >100° hue separation from the bold global tints.
 */
export class LocalColorLedger {
  private slots = new Map<string, number | 'overflow'>();
  private key = '';

  /** Slot pinned to `name`, or undefined. */
  get(name: string): number | 'overflow' | undefined {
    return this.slots.get(name);
  }

  /**
   * Ensure the ledger is scoped to `fnKey`; reset if the enclosing function
   * changed. Returns true if it was (re)built fresh.
   */
  private ensureScope(fnKey: string): boolean {
    if (this.key !== fnKey) {
      this.key = fnKey;
      this.slots.clear();
      return true;
    }
    return false;
  }

  /**
   * Pin the function's local identities in first-appearance order, skipping any
   * slot in `reserved` (held by a visible global). Idempotent within a scope:
   * re-seeding the same function keeps every prior pin. `overflow` past 6 hues.
   */
  seed(fnKey: string, localsInOrder: string[], reserved: Set<number>): void {
    this.ensureScope(fnKey);
    for (const name of localsInOrder) {
      if (this.slots.has(name)) {
        continue;
      }
      const used = new Set<number>(reserved);
      for (const v of this.slots.values()) {
        if (v !== 'overflow') {
          used.add(v);
        }
      }
      const free = INTERLEAVE.find((s) => !used.has(s));
      this.slots.set(name, free ?? 'overflow');
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

  // Local hues: seed all of the function's locals in function order, once. Every
  // sub-block of the function reads the same pins → stable colour.
  localLedger.seed(scope.fnKey, scope.fnLocalsInOrder, reserved);

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

  // 3. captures → bold idg, but hue from the function-local ledger.
  for (const r of out) {
    if (!r.info.isCapture) {
      continue;
    }
    const slot = localLedger.get(r.name);
    plan.set(
      r.name,
      slot === undefined || slot === 'overflow'
        ? { kind: 'neutral' }
        : { kind: 'idg', poolIndex: SLOT_TO_POOL_INDEX[slot] },
    );
  }

  // 4. fn-locals → normal id, hue from the function-local ledger.
  for (const r of fn) {
    const slot = localLedger.get(r.name);
    plan.set(
      r.name,
      slot === undefined || slot === 'overflow'
        ? { kind: 'neutral' }
        : { kind: 'id', poolIndex: SLOT_TO_POOL_INDEX[slot] },
    );
  }

  // 5. block-locals used ≥2 → normal id, hue from the function-local ledger.
  //    (Once-used block-locals were dropped by rank(); they stay neutral.)
  for (const r of block) {
    const slot = localLedger.get(r.name);
    plan.set(
      r.name,
      slot === undefined || slot === 'overflow'
        ? { kind: 'neutral' }
        : { kind: 'id', poolIndex: SLOT_TO_POOL_INDEX[slot] },
    );
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
