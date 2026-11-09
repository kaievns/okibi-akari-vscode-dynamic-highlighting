#!/usr/bin/env node
import * as util from './util.js';
const { join } = require('path');

const LIMIT = 10;
let total = 0;

function Counter(start) {
  this.count = start;
  var self = this;
  self.step = (n) => { self.count += n; total += n; };
}

/** @param {{ name: string }} opts [retries] */
export async function load({ name, retries = 3 }, ...rest) {
  const re = /(?<k>\w+)\/[/]/g;
  const raw = await util.read(join(name, `${rest.length}`));
  for (let i = 0; i < retries; i++) {
    if (raw.length > LIMIT && re.test(raw)) {
      total += raw.length / 2;
    }
  }
  return rest.map((x) => x + total).filter(y => y > LIMIT)[0];
}

module.exports = { load, Counter, pick: (items, limit) => items.filter((v) => v < limit && v !== util.max) };
