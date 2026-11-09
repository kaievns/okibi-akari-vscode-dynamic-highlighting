/**
 * Two-pass identity colouring — replaces the history-dependent ledger.
 *
 * The old model assigned hues first-visit-wins, so the palette depended on the
 * order you navigated blocks, and sibling blocks could independently claim the
 * same slot and then collide in a parent view. That is where the "random blanks
 * and inconsistent behaviour" came from.
 *
 * The fix separates two concerns that were entangled:
 *
 *   PASS 1 · VISIBILITY (per block, an attention budget)
 *     For each focusable block, rank its candidate names by attention priority —
 *     the block's own locals first, then borrowed-in (params/captures/globals)
 *     by use-count, then names owned by nested sub-scopes — and keep the top K
 *     (K = palette size). Pure function of code structure.
 *
 *   PASS 2 · IDENTITY (per colour scope, graph colouring)
 *     Vertices = every name visible in at least one block. Edge between two
 *     names iff they are CO-VISIBLE in some block. Greedy-colour the graph with
 *     the K hues in a deterministic order. Uncolourable → neutral.
 *
 * Why this is correct and stable:
 *   - A name's hue is a property of the FUNCTION, not of a visit → moving
 *     between sibling scopes never recolours a shared parent variable.
 *   - Two names that never appear on screen together share no edge, so they may
 *     safely reuse a hue. The spec's "never recycle" rule guards against a
 *     shared tint reading as the same binding — which can only be misread when
 *     both are visible at once. Non-co-visible reuse is invisible to the reader,
 *     and it is what lets K hues cover a function with far more than K locals.
 *   - No mutable history: same code → same colours, always. Recolour happens
 *     only on document change, which the spec permits as a cut.
 */

import { NameInfo } from './classify';

/** One focusable block's classified names (the output of classify per block). */
export interface BlockNames {
  /** Stable key for the block (focusKeyOf). */
  focusKey: string;
  /** Classified data identities used in that block. */
  byName: Map<string, NameInfo>;
  /** True for the synthetic module top-level scope (relaxes the ≥2-use floor). */
  isTopLevel?: boolean;
}

export interface ScopeColoring {
  /** name → palette index (0..K-1), or undefined for neutral. */
  hue: Map<string, number>;
  /** focusKey → the names visible in that block (the attention budget survivors). */
  visible: Map<string, string[]>;
}

/**
 * Attention-priority order within one block. Lower sorts first (wins a slot):
 *   1. proximity — 0 the block's own locals, 1 borrowed-in, 2 nested-scope
 *   2. frequency descending — within a tier, the more-referenced name
 *   3. first-appearance offset — deterministic final tiebreak
 *
 * `self` is excluded upstream (band 1 owns it) and `out` non-captures are true
 * globals which still participate: they are data and compete like anything else.
 */
function priorityRank(a: [string, NameInfo], b: [string, NameInfo]): number {
  return (
    a[1].proximity - b[1].proximity ||
    b[1].freqInBlock - a[1].freqInBlock ||
    a[1].firstBlockOffset - b[1].firstBlockOffset ||
    (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
  );
}

/**
 * Names eligible for a hue at all: data identities, excluding self.
 *
 * `isTopLevel` relaxes the ≥2-use floor. That floor exists so dense nested blocks
 * stay calm, but a module-level `const`/`var` is typically declared once at the
 * top and *used further down inside functions* — the exact case the reader wants
 * traced. Counting only its uses within the top-level scope would hide it.
 */
function eligible(byName: Map<string, NameInfo>, isTopLevel = false): [string, NameInfo][] {
  const out: [string, NameInfo][] = [];
  for (const entry of byName) {
    const info = entry[1];
    if (info.cls === 'self') {
      continue; // band 1 paints this/self; never consumes a hue
    }
    // A name owned by a NESTED sub-scope is not this block's data. Focus shows
    // the scope you are in; a child scope's internals belong to that scope's own
    // view. Ranking them last was not enough — with spare budget they still
    // painted, so focusing a function body lit up closure locals (`func(i, j int)`)
    // that mean nothing at this level. They become visible when the caret enters
    // the sub-scope, where they are proximity 0.
    if (info.proximity === 2) {
      continue;
    }
    // Own declarations at module top level (proximity 0) are exempt from the
    // use-count floor; everything else keeps it.
    const exempt = isTopLevel && info.proximity === 0;
    if (!exempt && info.cls === 'block' && info.freqInBlock < 2) {
      continue; // spec: once-used block-locals stay neutral so dense blocks stay calm
    }
    out.push(entry);
  }
  return out;
}

/**
 * PASS 1 — the visible set for one block: top-K by attention priority.
 */
export function visibleInBlock(
  byName: Map<string, NameInfo>,
  paletteSize: number,
  isTopLevel = false,
): string[] {
  return eligible(byName, isTopLevel)
    .sort(priorityRank)
    .slice(0, paletteSize)
    .map((e) => e[0]);
}

/**
 * PASS 2 — colour the co-visibility graph.
 *
 * Vertices are ordered by a deterministic global salience so greedy colouring is
 * reproducible: total co-visible degree descending (most-constrained first —
 * standard greedy heuristic, minimises neutrals), then earliest file appearance,
 * then name. Each vertex takes the lowest palette index not used by an already
 * coloured neighbour; if all K are taken by neighbours it goes neutral.
 */
export function colorScope(blocks: BlockNames[], paletteSize: number): ScopeColoring {
  const visible = new Map<string, string[]>();
  const adjacency = new Map<string, Set<string>>();
  const firstFileOffset = new Map<string, number>();

  const touch = (name: string): Set<string> => {
    let set = adjacency.get(name);
    if (!set) {
      set = new Set<string>();
      adjacency.set(name, set);
    }
    return set;
  };

  for (const block of blocks) {
    const names = visibleInBlock(block.byName, paletteSize, block.isTopLevel === true);
    visible.set(block.focusKey, names);
    for (const n of names) {
      touch(n);
      const info = block.byName.get(n);
      if (info) {
        const prev = firstFileOffset.get(n);
        if (prev === undefined || info.firstFileOffset < prev) {
          firstFileOffset.set(n, info.firstFileOffset);
        }
      }
    }
    // co-visible in this block → mutually adjacent (must differ)
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        touch(names[i]).add(names[j]);
        touch(names[j]).add(names[i]);
      }
    }
  }

  const order = [...adjacency.keys()].sort((a, b) => {
    const da = adjacency.get(a)?.size ?? 0;
    const db = adjacency.get(b)?.size ?? 0;
    return (
      db - da ||
      (firstFileOffset.get(a) ?? 0) - (firstFileOffset.get(b) ?? 0) ||
      (a < b ? -1 : a > b ? 1 : 0)
    );
  });

  const hue = new Map<string, number>();
  for (const name of order) {
    const taken = new Set<number>();
    for (const nb of adjacency.get(name) ?? []) {
      const h = hue.get(nb);
      if (h !== undefined) {
        taken.add(h);
      }
    }
    let pick: number | undefined;
    for (let i = 0; i < paletteSize; i++) {
      if (!taken.has(i)) {
        pick = i;
        break;
      }
    }
    if (pick !== undefined) {
      hue.set(name, pick);
    }
    // else: every hue is claimed by a co-visible neighbour → neutral (omitted)
  }

  return { hue, visible };
}
