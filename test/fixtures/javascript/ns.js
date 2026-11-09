import * as util from './util.js';
import * as path from 'node:path';
import fs from 'node:fs';
import { join } from 'node:path';
export function run(p) {
  const self = this;
  const a = util.helper(p);
  const b = path.join(a, 'x');
  const c = join(b, fs.existsSync(b) ? 'y' : 'z');
  console.log(self, globalThis, process.env.HOME, Deno.env.get('HOME'));
  return util.join(a, c);
}
