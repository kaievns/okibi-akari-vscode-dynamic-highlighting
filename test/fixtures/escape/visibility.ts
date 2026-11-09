// Declarations a block cannot see: another function's, a sibling block's.
export function first(xs: number[]): void {
  for (let i = 0; i < xs.length; i++) {
    console.log(xs[i]);
  }
}

export function sum(ys: number[]): number {
  let s = 0;
  for (let i = 0; i < ys.length; i++) {
    s += ys[i];
  }
  return s;
}

export function siblings(xs: number[]): number {
  let total = 0;
  if (xs.length > 0) {
    let k = 0;
    k += 1;
  }
  for (const x of xs) {
    if (x > 0) {
      let k = x;
      k += 1;
      total += k;
    }
  }
  for (let r = 0; r < xs.length; r++) total += r;
  for (const y of xs) {
    for (let r = 0; r < y; r++) {
      total -= r;
    }
  }
  return total;
}

export class Counter {
  count = 0;
  run(xs: number[]): void {
    for (let i = 0; i < xs.length; i++) {
      this.count += xs[i];
    }
  }
  reset(n: number): void {
    for (let i = 0; i < n; i++) {
      this.count -= 1;
    }
  }
}
