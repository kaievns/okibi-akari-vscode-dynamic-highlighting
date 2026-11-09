/**
 * Point queries over a fixed set of half-open intervals [start, end): which
 * interval covering an offset is best under an ordering. The boundaries split
 * the line into elementary segments; each segment stores its best covering
 * interval, so a query is one binary search. Exact for any intervals,
 * overlapping or nested. Empty and inverted intervals cover nothing.
 */

export interface IntervalIndex {
  /** Sorted distinct boundaries; segment s is [bounds[s], bounds[s + 1]). */
  readonly bounds: number[];
  /** Per segment, the index of the best covering interval, or -1. */
  readonly best: Int32Array;
}

/** A binary min-heap of interval indices under `before`. */
class Heap {
  private items: number[] = [];
  constructor(private readonly before: (a: number, b: number) => number) {}

  get size(): number {
    return this.items.length;
  }

  peek(): number {
    return this.items[0];
  }

  push(x: number): void {
    const a = this.items;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.before(a[i], a[p]) >= 0) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }

  pop(): void {
    const a = this.items;
    const last = a.pop()!;
    if (a.length === 0) return;
    a[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < a.length && this.before(a[l], a[m]) < 0) m = l;
      if (r < a.length && this.before(a[r], a[m]) < 0) m = r;
      if (m === i) break;
      [a[i], a[m]] = [a[m], a[i]];
      i = m;
    }
  }
}

/**
 * Index intervals `i` = [starts[i], ends[i]). `before(a, b) < 0` means a beats b;
 * it must be a total order (break ties on the index) for the result to be
 * deterministic.
 */
export function buildIntervalIndex(
  starts: ArrayLike<number>,
  ends: ArrayLike<number>,
  before: (a: number, b: number) => number,
): IntervalIndex {
  const order: number[] = [];
  const points: number[] = [];
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] < ends[i]) {
      order.push(i);
      points.push(starts[i], ends[i]);
    }
  }
  points.sort((a, b) => a - b);
  const bounds: number[] = [];
  for (const p of points) {
    if (bounds.length === 0 || bounds[bounds.length - 1] !== p) bounds.push(p);
  }
  order.sort((a, b) => starts[a] - starts[b] || a - b);
  const segments = Math.max(0, bounds.length - 1);
  const best = new Int32Array(segments);
  const heap = new Heap(before);
  let k = 0;
  for (let s = 0; s < segments; s++) {
    const left = bounds[s];
    while (k < order.length && starts[order[k]] <= left) heap.push(order[k++]);
    // An interval still in the heap with end > left covers the whole segment:
    // its end is a boundary, so it is at least bounds[s + 1].
    while (heap.size > 0 && ends[heap.peek()] <= left) heap.pop();
    best[s] = heap.size > 0 ? heap.peek() : -1;
  }
  return { bounds, best };
}

/** The best interval covering `offset`, or -1. */
export function bestAt(index: IntervalIndex, offset: number): number {
  const b = index.bounds;
  if (b.length < 2 || !(offset >= b[0]) || offset >= b[b.length - 1]) return -1;
  let lo = 0;
  let hi = b.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (b[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return index.best[lo];
}
