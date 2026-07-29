/**
 * Band-2 trace ranges — spec §5.5.
 *
 *   block-local      tint INSIDE the block.
 *   fn-local         trace across the enclosing FUNCTION (param decl + every
 *                    borrowed-in use).
 *   out-of-fn global trace FILE-WIDE.
 *   out-of-fn capture trace across its HOME function.
 *   self             occurrences of this/self within the enclosing function.
 *
 * User constraint 3: only names USED in the focused block are tinted — the plan
 * already encodes that (neutral names are dropped). This module just expands
 * each surviving name's file-wide occurrences to the right scope, clipping to
 * the class boundary. No re-scanning: occurrences come from the single decode
 * done in classify.
 */

import { Classification, OffsetRange, NameInfo } from './classify';
import { ColorPlan, ColorPlanEntry } from './colors';

/** A name's tint target: the occurrences to paint and which plan entry styles them. */
export interface TraceTarget {
  name: string;
  entry: ColorPlanEntry;
  ranges: OffsetRange[];
}

/** Defensive cap on ranges per name, to bound pathological files (spec §13.13). */
const MAX_RANGES_PER_NAME = 500;

function clip(ranges: OffsetRange[], bound: OffsetRange): OffsetRange[] {
  return ranges.filter((r) => r.start >= bound.start && r.end <= bound.end);
}

/**
 * Drop occurrences that belong to a SHADOWING binding of the same name.
 *
 * Occurrences are keyed by name, so a module-level `const cfgs` and a
 * `function summarize(cfgs)` parameter arrive as one list. Painting both one hue
 * asserts a data-flow link that does not exist — worse, it visually merges the
 * two identities shadowing already makes easy to confuse, so the highlighting
 * would invite the very bug class it should expose.
 *
 * `own` is the scope of the identity actually being traced (its declaring
 * function, or undefined for a true global). Any occurrence inside a DIFFERENT
 * declaring scope is a different variable, so it is removed.
 */
function dropShadowed(
  ranges: OffsetRange[],
  shadowScopes: OffsetRange[] | undefined,
  own: OffsetRange | undefined,
): OffsetRange[] {
  if (!shadowScopes || shadowScopes.length === 0) {
    return ranges;
  }
  const foreign = shadowScopes.filter((s) => !(own && s.start === own.start && s.end === own.end));
  if (foreign.length === 0) {
    return ranges;
  }
  return ranges.filter((r) => !foreign.some((s) => r.start >= s.start && r.end <= s.end));
}

function scopeFor(info: NameInfo, block: OffsetRange, enclosingFn: OffsetRange | undefined): OffsetRange | 'file' {
  switch (info.cls) {
    case 'block':
      return block;
    case 'fn':
      // No enclosing fn resolved (top-level / braceless) → degrade to file-wide.
      return enclosingFn ?? 'file';
    case 'self':
      return enclosingFn ?? 'file';
    case 'out':
      if (info.isCapture && info.homeFn) {
        return info.homeFn;
      }
      return 'file'; // true global, or capture with undetermined home → file-wide (D5)
  }
}

/**
 * Compute the per-name trace targets. Names absent from the plan, or planned
 * neutral, produce nothing.
 */
export function computeTraceRanges(c: Classification, plan: ColorPlan, block: OffsetRange): TraceTarget[] {
  const targets: TraceTarget[] = [];

  for (const [name, entry] of plan) {
    if (entry.kind === 'neutral') {
      continue;
    }
    const info = c.byName.get(name);
    if (!info) {
      continue;
    }
    // self names get their occurrences injected by the classifier (this/self are
    // keywords the token scan skips), so every class reaches here the same way:
    // no occurrences → nothing to tint.
    const occ = c.occurrences.get(name);
    if (!occ || occ.length === 0) {
      continue;
    }
    const scope = scopeFor(info, block, c.enclosingFn);
    let ranges = scope === 'file' ? occ.slice() : clip(occ, scope);

    // Subtract same-named bindings from OTHER scopes. Only a trace that leaves
    // the identity's own scope can pick them up: a `block`/`fn` trace is already
    // clipped to the enclosing function, so this bites on file-wide globals and
    // captures traced across their home function.
    const ownScope = info.cls === 'out' && info.isCapture ? info.homeFn : c.enclosingFn;
    ranges = dropShadowed(ranges, c.shadowScopes?.get(name), scope === 'file' ? undefined : ownScope);

    if (ranges.length === 0) {
      continue;
    }
    if (ranges.length > MAX_RANGES_PER_NAME) {
      ranges = ranges.slice(0, MAX_RANGES_PER_NAME);
    }
    targets.push({ name, entry, ranges });
  }

  return targets;
}
