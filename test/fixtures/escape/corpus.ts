const limit = 10;
let total = 0;
let count = 0;

interface Opts { retries?: number; limit?: number }
type Reducer = (acc: number, limit: number) => number;

// limit = 5 in a comment must not mark
/* total = 1 in a block comment */

function withDefaults(limit = 3, { retries = 2 } = {}) {
  const s = "count = 1";
  return limit + retries;
}

function shadowing(items: number[]) {
  let total = 0;
  for (const x of items) {
    total += x;
  }
  return total;
}

function escapes(items: number[]) {
  for (const x of items) {
    count++;
    total += x;
  }
  count = 0;
}

class Box {
  limit = 4;
  total: number = 0;
  constructor(private count: number) {
    this.total = count;
    this.limit = 1;
  }
  bump(opts: Opts) {
    this.count += 1;
    const o = { limit: 2, total };
    opts.limit = 7;
    return o;
  }
}

function paramWrite(retries: number) {
  retries = retries - 1;
  if (retries > 0) {
    retries -= 1;
  }
  return retries;
}

const arrow = (limit = 5) => limit * 2;

function destructure(src: { a?: number }) {
  const { a = 1 } = src;
  let b;
  [b = 2] = [a];
  return b;
}

let bits = 8;
function sink(n: number): number {
  return n;
}

function compound(m: Map<string, number>, xs: number[]) {
  let flags = 0;
  for (const x of xs) {
    flags |= x;
    count ??= 1;
    total ||= x;
    bits >>>= 1;
    xs[0] = x;
    m.set('k', x);
  }
  sink(count = 3);
  return flags;
}
