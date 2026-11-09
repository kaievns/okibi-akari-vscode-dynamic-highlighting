type Handler = (e: Event) => void

export const double = (x: number) => x * 2
export let hits = 0

export function on(name: string): () => void {
  return () => console.log(name)
}

export function f(a: number) {
  hits += 1
  return double(a) + hits
}

export function fold(xs: number[], commaRun: (i: number) => number): number {
  let t = 0
  for (let i = 0; i < xs.length; i++) {
    t += commaRun(i)
  }
  return t
}

export const chain = (ys: number[]) =>
  ys
    .map((y) => y + 1)
    .filter((y) => y > hits)

export const after = 1
