'use strict';
// The indexed lookups against the linear scans they replaced, on random inputs
// with overlaps, duplicates, ties, empty and inverted ranges. Each reference
// below is the earlier implementation, kept here as the specification.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildIntervalIndex, bestAt } = require('../out/intervals');
const classify = require('../out/classify');
const focus = require('../out/focus');
const { computeTraceRanges } = require('../out/traces');
const { lex } = require('../out/lex');

function rng(seed) {
  let s = seed;
  return (n) => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s % n;
  };
}

function randomRanges(rnd, count, span) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const start = rnd(span);
    const end = rnd(6) === 0 ? start - rnd(3) : start + rnd(Math.floor(span / 3));
    out.push({ start, end });
    if (rnd(5) === 0) out.push({ start, end });
  }
  return out;
}

const inRange = (o, r) => o >= r.start && o < r.end;

function linearEnclosing(fnRanges, offset) {
  let best;
  for (const r of fnRanges) {
    if (inRange(offset, r) && (!best || r.end - r.start < best.end - best.start)) best = r;
  }
  return best;
}

function linearOutermost(fnRanges, offset) {
  let best;
  for (const r of fnRanges) {
    if (inRange(offset, r) && (!best || r.end - r.start > best.end - best.start)) best = r;
  }
  return best;
}

test('bestAt matches a linear scan for the deepest, shortest and latest covering interval', () => {
  const rnd = rng(1);
  for (let t = 0; t < 400; t++) {
    const rs = randomRanges(rnd, rnd(40), 300);
    const starts = rs.map((r) => r.start);
    const ends = rs.map((r) => r.end);
    const weight = rs.map(() => rnd(6));
    const orders = [
      (a, b) => weight[b] - weight[a] || a - b,
      (a, b) => (ends[a] - starts[a]) - (ends[b] - starts[b]) || a - b,
      (a, b) => b - a,
    ];
    for (const before of orders) {
      const index = buildIntervalIndex(starts, ends, before);
      for (let o = -2; o < 420; o++) {
        let want = -1;
        for (let i = 0; i < rs.length; i++) {
          if (inRange(o, rs[i]) && (want < 0 || before(i, want) < 0)) want = i;
        }
        assert.equal(bestAt(index, o), want, `offset ${o}`);
      }
    }
  }
});

test('enclosingFnOf and outermostFnOf return the same range object as the linear scans, ties to the first', () => {
  const rnd = rng(2);
  for (let t = 0; t < 300; t++) {
    const fnRanges = randomRanges(rnd, 17 + rnd(60), 400);
    for (let o = -2; o < 540; o += 1 + rnd(3)) {
      assert.equal(classify.enclosingFnOf(fnRanges, o), linearEnclosing(fnRanges, o));
      assert.equal(classify.outermostFnOf(fnRanges, o), linearOutermost(fnRanges, o));
    }
  }
});

test('an fnRanges array that grows after a query is re-indexed', () => {
  const fnRanges = Array.from({ length: 20 }, (_, i) => ({ start: i * 10, end: i * 10 + 5 }));
  assert.equal(classify.enclosingFnOf(fnRanges, 207), undefined);
  fnRanges.push({ start: 200, end: 210 });
  assert.equal(classify.enclosingFnOf(fnRanges, 207), fnRanges[20]);
});

/** dropShadowed as it was: per occurrence, the innermost declaring scope around it must be `own`. */
function referenceTraces(c, plan, block) {
  const same = (a, b) => b !== undefined && a.start === b.start && a.end === b.end;
  const inside = (r, s) => r.start >= s.start && r.end <= s.end;
  const out = [];
  for (const [name, entry] of plan) {
    const info = c.byName.get(name);
    const occ = c.occurrences.get(name);
    let scope = 'file';
    if (info.cls === 'block') scope = block;
    else if (info.cls === 'fn') scope = c.enclosingFn ?? 'file';
    else if (info.cls === 'out' && info.isCapture && info.homeFn) scope = info.homeFn;
    let ranges = scope === 'file' ? occ.slice() : occ.filter((r) => r.start >= scope.start && r.end <= scope.end);
    const own = scope === 'file' ? undefined : (info.cls === 'out' && info.isCapture ? info.homeFn : c.enclosingFn);
    const foreign = (c.shadowScopes.get(name) ?? []).filter((s) => !same(s, own));
    if (foreign.length > 0) {
      ranges = ranges.filter((r) => {
        let innermost = own && inside(r, own) ? own : undefined;
        for (const s of foreign) {
          if (inside(r, s) && (!innermost || s.end - s.start < innermost.end - innermost.start)) innermost = s;
        }
        return innermost === undefined || same(innermost, own);
      });
    }
    if (ranges.length > 0) out.push({ name, entry, ranges: ranges.slice(0, 500) });
  }
  return out;
}

test('trace clipping against shadowing scopes matches the per-scope scan', () => {
  const rnd = rng(3);
  for (let t = 0; t < 5000; t++) {
    const occ = [];
    for (let o = rnd(5); occ.length < 30 && o < 200; o += 1 + rnd(12)) occ.push({ start: o, end: o + 3 });
    const scopes = randomRanges(rnd, rnd(9), 200);
    const own = rnd(3) === 0 ? undefined : (scopes.length > 0 && rnd(2) ? { ...scopes[rnd(scopes.length)] } : randomRanges(rnd, 1, 200)[0]);
    const cls = ['block', 'fn', 'out', 'out'][rnd(4)];
    const info = { cls, freqInBlock: 1, firstFileOffset: 0, firstBlockOffset: 0, isCapture: cls === 'out' && rnd(2) === 1, homeFn: own, proximity: 1 };
    const c = { byName: new Map([['x', info]]), occurrences: new Map([['x', occ]]), shadowScopes: new Map([['x', scopes]]), enclosingFn: own };
    const plan = new Map([['x', { kind: 'id', poolIndex: 0 }]]);
    const block = randomRanges(rnd, 1, 200)[0];
    assert.deepEqual(computeTraceRanges(c, plan, block), referenceTraces(c, plan, block));
  }
});

test('holeEndAt is the end of the latest-starting hole around the offset', () => {
  const sources = [
    ['typescript', 'const a = `x ${f(`y ${g(`z ${h}`)}`)} w ${k} ${ {a: `${b}`} }`;\nconst n = `${m} ${`${p}`}`;'],
    ['python', 'x = f"{a} {b:{w}} {f\'{c} {d!r}\'}"\ny = f"""{\n  e\n} {g}"""\n'],
    ['kotlin', 'val s = "$a ${b + "${c}"} $d"\n'],
  ];
  for (const [lang, src] of sources) {
    const lx = lex(src, lang);
    assert.ok(lx.holes.length >= 3, `${lang} has nested holes`);
    for (let o = -1; o <= src.length; o++) {
      let want = src.length;
      for (let k = lx.holes.length - 1; k >= 0; k--) {
        if (o >= lx.holes[k].start && o < lx.holes[k].end) {
          want = lx.holes[k].end;
          break;
        }
      }
      assert.equal(lx.holeEndAt(o), want, `${lang} offset ${o}`);
    }
  }
});

test('topLevelLines matches a per-character membership test', () => {
  const rnd = rng(4);
  const chars = ['a', ' ', '\t', '\n', '\r', '{', '}', 'x'];
  for (let t = 0; t < 300; t++) {
    let text = '';
    for (let i = 0; i < 300; i++) text += chars[rnd(chars.length)];
    const merged = [];
    for (let o = rnd(20); o < text.length; o += 1 + rnd(40)) {
      const end = o + 1 + rnd(30);
      merged.push({ start: o, end });
      o = end;
    }
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
    const inside = (i) => merged.some((r) => i >= r.start && i < r.end);
    const want = [];
    for (let line = 0; line < lineStarts.length; line++) {
      const ls = lineStarts[line];
      const le = line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : text.length;
      let saw = false;
      let outside = false;
      for (let i = ls; i < le; i++) {
        if (text[i] === ' ' || text[i] === '\t' || text[i] === '\r') continue;
        saw = true;
        if (!inside(i)) {
          outside = true;
          break;
        }
      }
      if (saw ? outside : !inside(ls)) want.push(line);
    }
    assert.deepEqual(focus.topLevelLines(text, lineStarts, merged), want);
  }
});

test('topLevelBlock counts lines without splitting, and a repeated call returns a fresh object', () => {
  for (const text of ['', 'a', 'a\n', '\n\n', 'a\nb\r\nc']) {
    const b = focus.topLevelBlock(text);
    assert.deepEqual(b, {
      openLine: 0, closeLine: Math.max(0, text.split('\n').length - 1), depth: -1,
      openOffset: 0, closeOffset: Math.max(0, text.length - 1), headerStart: 0,
    });
    b.closeLine = 99;
    assert.notEqual(focus.topLevelBlock(text).closeLine, 99);
  }
});
