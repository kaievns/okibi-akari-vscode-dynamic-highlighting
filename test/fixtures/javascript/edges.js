#!/usr/bin/env node
'use strict';
import fs, { readFileSync as rf, constants } from 'node:fs';
import * as util from './util.js';
import * as path from 'node:path';
export * from './reexport.js';
export * as ns2 from './reexport.js';
export { rf as readFile, util };
export default function main() {}
const cjs = require('./cjs.cjs');
const { join, resolve: res = path.resolve } = require('path');
module.exports = { cjs };
exports.helper = () => cjs;

const lazy = await import('./lazy.js');
const meta = import.meta.url;

/**
 * @typedef {Object} Opts
 * @property {string} name - the name
 * @param {Opts} opts
 * @returns {Promise<number>}
 */
async function run(opts = {}, ...rest) {
  const { name = 'x', retries: tries = 3, ...others } = opts;
  let [first, , third = 1, ...tail] = rest;
  /** @type {number} */
  let total = 0n + 10n;
  total = 1_000_000 ** 2 * 0xff_ff;
  const re = /(?<year>\d{4})-(?<m>\d{2})\/[/]/gv;
  const div = total / 2 / 3;
  const after = (div) / 2;
  if (opts) /re/.test(name);
  const arr = [1, 2][0] / 2;
  const obj = { a: 1 }.a / 2;
  outer: for (const x of rest) {
    for (let i = 0; i < x; i++) {
      if (i === 2) continue outer;
      if (i === 3) break outer;
    }
  }
  const t = `a${name}b${`inner ${first + `deep ${third}`}`}c`;
  const tagged = String.raw`\n${total}`;
  const q = gql`query { user(id: ${first}) { name } }`;
  const h = html`<div class="${name}">${tail.map((x) => html`<i>${x}</i>`)}</div>`;
  const c = css`color: ${'red'};`;
  opts.x ??= 1;
  opts.y ||= 2;
  opts.z &&= 3;
  const v = opts?.a?.[0]?.(first) ?? null;
  const n = void 0, ty = typeof opts, inst = opts instanceof Object, has = 'a' in opts;
  delete opts.a;
  const seq = (first, third);
  with (opts) { total += 1; }
  eval('total');
  if (new.target) return;
  return total + NaN + Infinity + undefined;
}

function* gen() {
  yield 1;
  yield* [2, 3];
}

class Base {}
class Widget extends Base {
  static count = 0;
  #secret = 1;
  name;
  static { Widget.count = 1; }
  constructor(name) { super(); this.name = name; this.#secret = 2; }
  get secret() { return this.#secret; }
  set secret(v) { this.#secret = v; }
  #hidden() { return #secret in this; }
  static create() { return new Widget('w'); }
  async *items() { for await (const x of []) yield x; }
  accessor size = 1;
}

const o = {
  get val() { return 1; },
  set val(x) { this._v = x; },
  method() { return this; },
  [Symbol.iterator]: function* () {},
  arrow: (a) => a * 2,
  bare: a => a + 1,
};

(function iife() { return 1; })();
(() => { let z = 1; return z; })();
const curry = (a) => (b) => a + b;

let state = 0;
globalThis.flag = true;
function bump() {
  state += 1;
  counter = 3;
  window.x = 1;
  this.y = 2;
}
let a = 1
let b = a
/2/1
const asi = a
;[1, 2].forEach((x) => x)
const asi2 = b
;(function () {})()
