/**
 * Band-2 render plan: turns a scope colouring (scopecolor.ts) into the pool
 * entry each visible name paints with.
 *
 * The pool is five tints (tokens.ts `TOKENS.id`): locals and captures at normal
 * weight (`id`), globals bold in the same hex (`idg`), this/self in band 1's
 * keyword colour (`self`). Hues never hash and never recycle between names that
 * are visible together; the ordering rules live in scopecolor.ts.
 */

import { NameInfo } from './classify';

export type ColorPlanEntry =
  | { kind: 'id'; poolIndex: number }
  | { kind: 'idg'; poolIndex: number }
  | { kind: 'self' }
  | { kind: 'neutral' };

export type ColorPlan = Map<string, ColorPlanEntry>;

/**
 * Build the render plan for the focused block from a SCOPE COLOURING
 * (scopecolor.ts).
 *
 *   - Which names paint: the block's visible set (pass 1, attention budget).
 *   - What hue: the co-visibility graph colour (pass 2, per colour scope).
 *   - Which tier: out-of-fn non-captures render bold (`idg`), everything else
 *     normal (`id`) — weight carries the local/global distinction now that both
 *     tiers share one tint set. self is never painted (band 1 owns it).
 *
 * Deterministic: no navigation history. Same document → same plan.
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

  // `self` never appears in `visible` — it is excluded upstream so it cannot consume
  // a hue slot (scopecolor.ts `eligible`). So it is picked up from byName directly,
  // and emitted so the decorator can RESTORE band 1's keyword colour.
  //
  // Why that restoration is needed at all: on a `.rs` file outside a cargo workspace
  // — no Cargo.toml above it, which is every loose Rust file — rust-analyzer degrades
  // a `self` USE to the semantic type `const`. A semantic token overrides the
  // grammar, and `const` has no declared fallback scope, so `self.retries` rendered
  // at editor.foreground: plain white, while the `self` in the signature (still typed
  // `selfKeyword`) looked correct. No theme rule can separate them, because the
  // degraded `self` and an ordinary local carry the SAME type — only this layer knows
  // which is which. The decoration is band 1's own colour at normal weight, so it is
  // invisible wherever the grammar already won, and there is no flip on focus change.
  for (const [name, info] of classification.byName) {
    if (info.cls === 'self') {
      plan.set(name, { kind: 'self' });
    }
  }

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
