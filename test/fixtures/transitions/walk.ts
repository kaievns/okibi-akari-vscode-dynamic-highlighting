import { readFile } from 'fs';

const LIMIT = 10;
let total = 0;

export class Loader {
  private retries = 3;

  async load(path: string): Promise<number> {
    const raw = (await readFile(path)) as any;
    for (let i = 0; i < this.retries; i++) {
      if (raw.length > LIMIT) {
        total += raw.length * 2;
      }
    }
    return [1, 2].map((x) => x + total).filter((y) => y > LIMIT)[0];
  }
}

function pick(items: number[], limit: number): number[] {
  return items.filter((v) => v < limit && v !== total);
}
