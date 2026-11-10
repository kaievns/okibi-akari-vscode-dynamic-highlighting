'use strict';
// Transitions: seeded random walks over editor events, each step compared with a
// fresh Decorator given the same final state. A difference is a leftover of an
// earlier state. Model and oracle: docs/runtime.md#transitions.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./transitions-harness');
const { mayForceMove, positionMovedBy, rangesMovedBy } = require('../out/tracking');
const { Phase } = require('../out/phases');

const WALKS = Number(process.env.OKIBI_WALKS ?? 300);
const STEPS = Number(process.env.OKIBI_STEPS ?? 40);
const SEED0 = Number(process.env.OKIBI_SEED ?? 1);
const RECLOSE_WALKS = Number(process.env.OKIBI_RECLOSE_WALKS ?? 200);
const RECLOSE_STEPS = Number(process.env.OKIBI_RECLOSE_STEPS ?? 16);
const DEFAULT_RUN = WALKS === 300 && STEPS === 40 && SEED0 === 1;

/** Every walk from `seed0` passes, and more than `minQuiet` of the steps compared every type. */
async function walks(generate, count, steps, seed0, minQuiet, trace) {
  h.enterFakeTime();
  try {
    let compared = 0;
    let quiet = 0;
    for (let seed = seed0; seed < seed0 + count; seed++) {
      const { cfg, events } = generate(seed, steps);
      const r = await h.runWalk(cfg, events, trace);
      compared += r.compared;
      quiet += r.quiet;
      if (r.failure) {
        const small = await h.shrink(cfg, events, r.failure.step);
        assert.fail(`seed ${seed}, step ${r.failure.step}: ${r.failure.diff}\n` +
          `shrunk to ${small.events.length} events: ${small.diff}\n${h.show(cfg, small.events)}`);
      }
    }
    assert.ok(quiet > compared * minQuiet, `every decoration type compared at ${quiet} of ${compared} steps`);
  } finally {
    h.exitFakeTime();
  }
}

const DATA_LANGS = h.DATA_KEYS.map((k) => h.FIXTURES[k].lang);
const CODE_LANGS = new Set(['typescript', 'python', 'rust', 'go']);

test(`${WALKS} random walks of ${STEPS} steps leave no leftovers`, async (t) => {
  let steps = 0;
  const active = Object.fromEntries(DATA_LANGS.map((l) => [l, 0]));
  let codeMoves = 0;
  let dataMoves = 0;
  let last = null;
  await walks(h.generate, WALKS, STEPS, SEED0, 1 / 2, (i, ev, r, w) => {
    steps++;
    const lang = w.activeEditor()?.document.languageId ?? null;
    if (lang in active) active[lang]++;
    if (i > 0 && last !== lang) {
      if (lang in active && last in active) dataMoves++;
      else if ((lang in active && CODE_LANGS.has(last)) || (last in active && CODE_LANGS.has(lang))) codeMoves++;
    }
    last = lang;
  });
  const seen = `data files active at ${Object.entries(active).map(([l, n]) => `${l} ${n}`).join(', ')} of ${steps} steps; ` +
    `the active editor moved between a data file and a code file ${codeMoves} times, between two data files ${dataMoves}`;
  // Some data walks never activate their file, so only the default run has floors (docs/runtime.md#the-oracle).
  if (DEFAULT_RUN) {
    for (const [l, n] of Object.entries(active)) assert.ok(n > 0, `${l}: ${seen}`);
    assert.ok(Object.values(active).reduce((a, b) => a + b, 0) > steps / 40, seen);
  }
  t.diagnostic(seen);
});

test(`${RECLOSE_WALKS} walks that unclose and reclose a docstring leave no leftovers`, () =>
  walks(h.generateReclose, RECLOSE_WALKS, RECLOSE_STEPS, SEED0, 1 / 4));

const LUA_WALKS = Number(process.env.OKIBI_LUA_WALKS ?? 120);

test(`${LUA_WALKS} random walks over walk.lua leave no leftovers`, async (t) => {
  // Steps on which walk.lua showed each kind of paint, so the walks are known to cover them.
  const shown = { tint: 0, clay: 0, importRestore: 0, shadowRestore: 0, riskEscape: 0, self: 0, placeholder: 0 };
  await walks(h.generateLua, LUA_WALKS, STEPS, SEED0, 1 / 2, (i, ev, r) => {
    const lua = r.got.editors.find((e) => e.uri.endsWith('.lua'));
    const roles = new Set(Object.keys(lua?.out ?? {}).map((k) => k.split(' ')[0]));
    if ([...roles].some((x) => /^(id|idg)\d$/.test(x))) shown.tint++;
    if (roles.has('numberEngaged')) shown.clay++;
    for (const k of ['importRestore', 'shadowRestore', 'riskEscape', 'self', 'placeholder']) if (roles.has(k)) shown[k]++;
  });
  const seen = Object.entries(shown).map(([k, n]) => `${k} ${n}`).join(', ');
  if (DEFAULT_RUN && LUA_WALKS === 120) for (const [k, n] of Object.entries(shown)) assert.ok(n > 0, `${k}: ${seen}`);
  t.diagnostic(`walk.lua painted, in steps: ${seen}`);
});

test(`${LUA_WALKS} walks that unclose and reclose a Lua long comment or an end leave no leftovers`, () =>
  walks(h.generateLuaReclose, LUA_WALKS, RECLOSE_STEPS, SEED0, 1 / 4));

const JS_WALKS = Number(process.env.OKIBI_JS_WALKS ?? 120);

test(`${JS_WALKS} random walks over walk.js leave no leftovers`, async (t) => {
  const shown = { tint: 0, clay: 0, importRestore: 0, riskEscape: 0, self: 0, riskAsync: 0, placeholder: 0, commentRestore: 0 };
  await walks(h.generateJs, JS_WALKS, STEPS, SEED0, 1 / 2, (i, ev, r) => {
    const js = r.got.editors.find((e) => e.uri.endsWith('.js'));
    const roles = new Set(Object.keys(js?.out ?? {}).map((k) => k.split(' ')[0]));
    if ([...roles].some((x) => /^(id|idg)\d$/.test(x))) shown.tint++;
    if (roles.has('numberEngaged')) shown.clay++;
    for (const k of ['importRestore', 'riskEscape', 'self', 'riskAsync', 'placeholder', 'commentRestore']) if (roles.has(k)) shown[k]++;
  });
  const seen = Object.entries(shown).map(([k, n]) => `${k} ${n}`).join(', ');
  if (DEFAULT_RUN && JS_WALKS === 120) for (const [k, n] of Object.entries(shown)) assert.ok(n > 0, `${k}: ${seen}`);
  t.diagnostic(`walk.js painted, in steps: ${seen}`);
});

const RUBY_WALKS = Number(process.env.OKIBI_RUBY_WALKS ?? 120);

test(`${RUBY_WALKS} random walks over walk.rb leave no leftovers`, async (t) => {
  const shown = { tint: 0, clay: 0, shadowRestore: 0, riskEscape: 0, self: 0, placeholder: 0 };
  await walks(h.generateRuby, RUBY_WALKS, STEPS, SEED0, 1 / 2, (i, ev, r) => {
    const rb = r.got.editors.find((e) => e.uri.endsWith('.rb'));
    const roles = new Set(Object.keys(rb?.out ?? {}).map((k) => k.split(' ')[0]));
    if ([...roles].some((x) => /^(id|idg)\d$/.test(x))) shown.tint++;
    if (roles.has('numberEngaged')) shown.clay++;
    for (const k of ['shadowRestore', 'riskEscape', 'self', 'placeholder']) if (roles.has(k)) shown[k]++;
  });
  const seen = Object.entries(shown).map(([k, n]) => `${k} ${n}`).join(', ');
  if (DEFAULT_RUN && RUBY_WALKS === 120) for (const [k, n] of Object.entries(shown)) assert.ok(n > 0, `${k}: ${seen}`);
  t.diagnostic(`walk.rb painted, in steps: ${seen}`);
});

test(`${RUBY_WALKS} walks that unclose and reclose a Ruby heredoc or an end leave no leftovers`, () =>
  walks(h.generateRubyReclose, RUBY_WALKS, RECLOSE_STEPS, SEED0, 1 / 4));

const ZIG_WALKS = Number(process.env.OKIBI_ZIG_WALKS ?? 120);

test(`${ZIG_WALKS} random walks over walk.zig and walk.zon leave no leftovers`, async (t) => {
  const shown = { tint: 0, clay: 0, importRestore: 0, riskEscape: 0, riskDanger: 0, self: 0, placeholder: 0, zonActive: 0 };
  await walks(h.generateZig, ZIG_WALKS, STEPS, SEED0, 1 / 2, (i, ev, r, w) => {
    if (w.activeEditor()?.document.fileName.endsWith('.zon')) shown.zonActive++;
    const zig = r.got.editors.find((e) => e.uri.endsWith('.zig'));
    const roles = new Set(Object.keys(zig?.out ?? {}).map((k) => k.split(' ')[0]));
    if ([...roles].some((x) => /^(id|idg)\d$/.test(x))) shown.tint++;
    if (roles.has('numberEngaged')) shown.clay++;
    for (const k of ['importRestore', 'riskEscape', 'riskDanger', 'self', 'placeholder']) if (roles.has(k)) shown[k]++;
    assert.ok(!roles.has('riskAsync'), `step ${i}: no async marks in Zig`);
  });
  const seen = Object.entries(shown).map(([k, n]) => `${k} ${n}`).join(', ');
  if (DEFAULT_RUN && ZIG_WALKS === 120) for (const [k, n] of Object.entries(shown)) assert.ok(n > 0, `${k}: ${seen}`);
  t.diagnostic(`walk.zig painted, in steps: ${seen}`);
});

test(`${ZIG_WALKS} walks that unclose and reclose a Zig string, a \\\\ line or a block leave no leftovers`, () =>
  walks(h.generateZigReclose, ZIG_WALKS, RECLOSE_STEPS, SEED0, 1 / 4));

const PROSE_WALKS = Number(process.env.OKIBI_PROSE_WALKS ?? 100);

test(`${PROSE_WALKS} random walks over the markdown-derived files leave no leftovers`, async (t) => {
  // Steps on which each id was the active editor, and on which its editor showed a markdown mark.
  const active = Object.fromEntries(h.PROSE_KEYS.map((k) => [h.FIXTURES[k].lang, 0]));
  const marked = Object.fromEntries(h.PROSE_KEYS.filter((k) => h.FIXTURES[k].marks).map((k) => [h.FIXTURES[k].lang, 0]));
  let beside = 0;
  await walks(h.generateProse, PROSE_WALKS, STEPS, SEED0, 1 / 2, (i, ev, r, w) => {
    const lang = w.activeEditor()?.document.languageId;
    if (lang in active) active[lang]++;
    const shown = w.visible().map((ed, j) => [ed.document.languageId, Object.keys(r.got.editors[j].out).map((k) => k.split(' ')[0])]);
    for (const [l, roles] of shown) if (l in marked && roles.some((x) => x.startsWith('md'))) marked[l]++;
    if (shown.some(([l]) => l in active) && shown.some(([, roles]) => roles.some((x) => x === 'gutter' || /^id/.test(x)))) beside++;
  });
  const seen = `active: ${Object.entries(active).map(([l, n]) => `${l} ${n}`).join(', ')}; ` +
    `marked: ${Object.entries(marked).map(([l, n]) => `${l} ${n}`).join(', ')}; beside a painted code editor at ${beside} steps`;
  if (DEFAULT_RUN && PROSE_WALKS === 100) {
    for (const [l, n] of [...Object.entries(active), ...Object.entries(marked)]) assert.ok(n > 0, `${l}: ${seen}`);
    assert.ok(beside > 0, seen);
  }
  t.diagnostic(seen);
});

const CONTAINER_WALKS = Number(process.env.OKIBI_CONTAINER_WALKS ?? 100);

test(`${CONTAINER_WALKS} random walks over the Docker and Kubernetes files beside a code file leave no leftovers`, async (t) => {
  const active = Object.fromEntries(h.CONTAINER_KEYS.map((k) => [k, 0]));
  const keyOf = (ed) => ed?.document.uri.toString().split('.').pop();
  let beside = 0;
  await walks(h.generateContainers, CONTAINER_WALKS, STEPS, SEED0, 1 / 2, (i, ev, r, w) => {
    if (keyOf(w.activeEditor()) in active) active[keyOf(w.activeEditor())]++;
    const shown = w.visible().map((ed, j) => [keyOf(ed), Object.keys(r.got.editors[j].out).map((k) => k.split(' ')[0])]);
    if (shown.some(([k]) => k in active) && shown.some(([, roles]) => roles.some((x) => x === 'gutter' || /^id/.test(x)))) beside++;
  });
  const seen = `active: ${Object.entries(active).map(([f, n]) => `${f} ${n}`).join(', ')}; beside a painted code editor at ${beside} steps`;
  if (DEFAULT_RUN && CONTAINER_WALKS === 100) {
    for (const [f, n] of Object.entries(active)) assert.ok(n > 0, `${f}: ${seen}`);
    assert.ok(beside > 0, seen);
  }
  t.diagnostic(seen);
});

// ── Leftovers the walks found, as their shrunk sequences ──────────────────────

const LUA_FORMAT = h.FIXTURES.lua.text.split('\n').findIndex((l) => /string\.format/.test(l));

const REGRESSIONS = [
  [
    'an edit to a visible document that is not active repaints its band-1 marks',
    // A rename while the Output panel has focus breaks the Go import block; the
    // import restore stayed on `fmt` and `strings` until the next render.
    { docs: ['go'], provider: { go: { mode: 'none', latency: 90 } } },
    [{ t: 'output', log: true }, { t: 'foreign', line: 2, op: 'rename' }],
  ],
  [
    'an answer that turns semanticOk on takes the import restore off even when band 2 discards it',
    // The v1 answer lands after the paste made v2: band 2 drops it, and the restore
    // stayed on until v2's answer.
    { docs: ['py'], provider: { python: { mode: 'ok', latency: 300 } } },
    [{ t: 'idle', dt: 90 }, { t: 'paste', text: 'import heapq\nheapq.heapify(x)\n', dt: 400 }],
  ],
  [
    'deleting a range and undoing it before the repaint paints the restored tints again',
    // VS Code collapses a decoration whose text is deleted; the undo's plan equals
    // the one painted before, so the dirty-check skipped it and `LIMIT` stayed bare.
    { docs: ['py'], provider: { python: { mode: 'none', latency: 0 } } },
    [
      { t: 'caret', line: 1, character: 9, kind: 2, dt: 200 },
      { t: 'deleteRange', length: 25 },
      { t: 'undo', dt: 400 },
    ],
  ],
  [
    'a render between an edit and its caret update is redone when the caret lands',
    // The render after typing `}` reads the old caret against the new text, inside
    // the new `{}` block; the caret then lands in the block it was in before, so
    // nothing repainted the gutter.
    { docs: ['ts'], provider: { typescript: { mode: 'empty', latency: 90 } } },
    [{ t: 'type', text: '{' }, { t: 'type', text: '}' }],
  ],
  [
    'an answer for older text does not override the newer answer',
    // The v1 request hangs, v2 answers `none`, then v1's `ok` arrives: it set the
    // path keywords and semanticOk for a version the document has left.
    { docs: ['rs'], provider: { rust: { mode: 'degraded', latency: 0 } } },
    [
      { t: 'provider', lang: 'rust', mode: 'ok', latency: 'never' },
      { t: 'idle', dt: 90 },
      { t: 'provider', lang: 'rust', mode: 'none', latency: 300 },
      { t: 'type', text: ';', dt: 1200 },
      { t: 'release' },
    ],
  ],
  [
    'an edit that puts the caret in another block, with no caret move, still paints it',
    // Indenting the line under the header makes `def pick` a block around the caret.
    // Its plan failed the epoch guard against the focus key of the last caret move.
    { docs: ['py'], provider: { python: { mode: 'degraded', latency: 0 } } },
    [
      { t: 'caret', line: 4, character: 0, kind: 2, dt: 200 },
      { t: 'type', text: 'def pick(items, limit):', dt: 200 },
      { t: 'foreign', insert: '    return items[limit]\n', line: 5, dt: 400 },
    ],
  ],
  [
    'a forced insert right after a marked name repaints the mark it grew over',
    // A quick fix appends `._x` to `self`. VS Code applies it with forceMoveMarkers,
    // so the `self` mark grew over `._x`; unforced it would not have, and the
    // recomputed ranges equal the record, so nothing was re-sent.
    { docs: ['py'], provider: { python: { mode: 'none', latency: 0 } } },
    [{ t: 'idle', dt: 500 }, { t: 'foreign', op: 'append', line: 8, character: 12, text: '._x', dt: 3000 }],
  ],
  [
    'answers that land out of order leave band 1 as the last one says',
    // Seed 20404: the v3 answer types string literals and renders the placeholders;
    // the v4 answer does not, but its classify compared with the state it started
    // from, which also typed none, so nothing took them off.
    { docs: ['zig'], provider: { zig: { mode: 'strings', latency: 90 } } },
    [
      { t: 'provider', lang: 'zig', mode: 'ok', latency: 90, dt: 0 },
      { t: 'unclose', line: 26, at: 9, dt: 400 },
      { t: 'provider', lang: 'zig', mode: 'strings', latency: 300, dt: 0 },
      { t: 'type', text: '\\', dt: 160 },
      { t: 'provider', lang: 'zig', mode: 'ok', latency: 300, dt: 0 },
      { t: 'undo', dt: 160 },
      { t: 'type', text: ' ', dt: 400 },
    ],
  ],
  [
    'answers that land out of order leave band 1 as the last one says, in Lua',
    { docs: ['lua'], provider: { lua: { mode: 'strings', latency: 90 } } },
    [
      { t: 'provider', lang: 'lua', mode: 'ok', latency: 90, dt: 0 },
      { t: 'unclose', line: LUA_FORMAT, at: h.FIXTURES.lua.text.split('\n')[LUA_FORMAT].length - 2, dt: 400 },
      { t: 'provider', lang: 'lua', mode: 'strings', latency: 300, dt: 0 },
      { t: 'type', text: 'x', dt: 160 },
      { t: 'provider', lang: 'lua', mode: 'ok', latency: 300, dt: 0 },
      { t: 'undo', dt: 160 },
      { t: 'type', text: ' ', dt: 400 },
    ],
  ],
  [
    'a forced insert on the caret line, away from the caret, is not taken for typing',
    // The quick fix runs from the caret's line, which every change touching a caret
    // line would read as typing, and so as unforced.
    { docs: ['py'], provider: { python: { mode: 'none', latency: 0 } } },
    [
      { t: 'caret', line: 8, character: 4, kind: 2, dt: 500 },
      { t: 'foreign', op: 'append', line: 8, character: 12, text: '._x', dt: 3000 },
    ],
  ],
];

for (const [name, cfg, events] of REGRESSIONS) {
  test(name, async () => {
    h.enterFakeTime();
    try {
      const r = await h.runWalk(cfg, events);
      assert.equal(r.failure, null, r.failure && `step ${r.failure.step}: ${r.failure.diff}`);
    } finally {
      h.exitFakeTime();
    }
  });
}

// ZON opens under `zig`, whose server answers it, and VS Code answers the chat customisation ids.
const MD_MARKS = ['mdHighlight', 'mdLinkPlain'];
for (const key of [...h.DATA_KEYS, ...h.CONTAINER_KEYS, 'zon', ...h.PROSE_KEYS]) test(`switching between a code file in Edit and a ${key} file leaves ${h.FIXTURES[key].marks ? 'only the markdown marks' : 'nothing'} on the ${key} file`, async () => {
  const lang = h.FIXTURES[key].lang;
  const shows = h.FIXTURES[key].marks ? MD_MARKS : [];
  const answered = key === 'zon' || shows.length > 0;
  const cfg = { docs: ['ts', key], split: true, provider: { typescript: { mode: 'ok', latency: 0 }, [lang]: { mode: answered ? 'ok' : 'none', latency: 0 } } };
  const events = [
    { t: 'caret', line: 12, character: 12, kind: 2, dt: 200 },
    { t: 'type', text: 'x', dt: 30 },
    { t: 'focusOther', a: 0.3, b: 0.2, dt: 30 },
    { t: 'type', text: 'self', dt: 400 },
    { t: 'paste', a: 0.8, b: 0.9, dt: 400 },
    { t: 'focusOther', a: 0.5, b: 0.2, dt: 30 },
    { t: 'openTab', a: 0.9, dt: 400 },
    { t: 'closeTab', b: 0.9, dt: 400 },
  ];
  const seen = [];
  h.enterFakeTime();
  try {
    const r = await h.runWalk(cfg, events, (i, ev, res, w) => {
      const roles = (lang) => res.got.editors.filter((e, j) => w.visible()[j].document.languageId === lang)
        .flatMap((e) => Object.keys(e.out).map((k) => k.split(' ')[0]));
      seen.push({ active: w.activeEditor()?.document.languageId, phase: w.d.machine.current, ts: roles('typescript'), data: roles(lang) });
    });
    assert.equal(r.failure, null, r.failure && `step ${r.failure.step}: ${r.failure.diff}`);
  } finally {
    h.exitFakeTime();
  }
  const tinted = (roles) => roles.includes('gutter') && roles.some((x) => /^id/.test(x));
  assert.ok(seen[0].phase === Phase.Focus && tinted(seen[0].ts), `control: the TS file paints a stripe and tints, ${JSON.stringify(seen[0])}`);
  assert.equal(seen[1].phase, Phase.Edit, 'control: typing reaches Edit before the switch');
  // The paste can open a fence, which takes the marks below it off.
  for (const i of [2, 3, 4, 6]) {
    assert.deepEqual([seen[i].active, seen[i].phase, seen[i].data.filter((x) => !shows.includes(x))], [lang, Phase.Survey, []], `step ${i}: ${events[i].t}`);
  }
  assert.deepEqual([...new Set(seen[2].data)].sort(), shows, `the ${key} file's marks on the switch`);
  assert.ok(tinted(seen[7].ts), `closing the ${key} tab paints the TS file again, ${JSON.stringify(seen[7])}`);
});

// ── Decorations move with edits ───────────────────────────────────────────────

const P = (line, character) => ({ line, character });
const change = (sl, sc, el, ec, text) => ({ range: { start: P(sl, sc), end: P(el, ec) }, text });
const CLOSED = 1;
const OPEN = 0;

test('rangesMovedBy: exact outside the replaced text, sticky at the insertion point', () => {
  const r = [{ start: P(2, 4), end: P(2, 8) }];
  assert.equal(rangesMovedBy(change(2, 8, 2, 8, ' '), r, CLOSED), false, 'typing just after a ClosedClosed range');
  assert.equal(rangesMovedBy(change(2, 8, 2, 8, ' '), r, OPEN), true, 'an OpenOpen range grows');
  assert.equal(rangesMovedBy(change(2, 4, 2, 4, 'x'), r, CLOSED), true, 'typing at its start pushes it right');
  assert.equal(rangesMovedBy(change(2, 8, 2, 9, ''), r, CLOSED), false, 'deleting the character after it');
  assert.equal(rangesMovedBy(change(2, 0, 2, 1, 'y'), r, CLOSED), false, 'same-length replace earlier on the line');
  assert.equal(rangesMovedBy(change(2, 0, 2, 0, 'y'), r, CLOSED), true, 'an insert earlier on the line');
  assert.equal(rangesMovedBy(change(5, 0, 5, 0, '\n'), r, CLOSED), false, 'a newline below');
  assert.equal(rangesMovedBy(change(0, 3, 0, 3, 'abc'), r, CLOSED), false, 'typing on a line above');
  assert.equal(rangesMovedBy(change(0, 3, 0, 3, '\n'), r, CLOSED), true, 'a newline above');
  assert.equal(rangesMovedBy(change(1, 0, 2, 6, ''), r, CLOSED), true, 'deleting into it');
  assert.equal(positionMovedBy(P(3, 2), change(1, 5, 2, 0, 'a\nb'), true), false, 'a line-count-neutral multi-line replace');
});

test('rangesMovedBy: a forced edit moves a marker at its start past the inserted text', () => {
  const r = [{ start: P(8, 8), end: P(8, 12) }];
  assert.equal(rangesMovedBy(change(8, 12, 8, 12, '._x'), r, CLOSED), false, 'typed just after: the end sticks');
  assert.equal(rangesMovedBy(change(8, 12, 8, 12, '._x'), r, CLOSED, true), true, 'forced just after: it grows');
  assert.equal(rangesMovedBy(change(8, 12, 8, 14, 'ab'), r, CLOSED), false, 'a typed replace starting at its end');
  assert.equal(rangesMovedBy(change(8, 12, 8, 14, 'ab'), r, CLOSED, true), true, 'a forced replace starting at its end');
  assert.equal(rangesMovedBy(change(8, 12, 8, 14, ''), r, CLOSED, true), false, 'a forced deletion starting at its end');
  assert.equal(rangesMovedBy(change(8, 13, 8, 13, ','), r, CLOSED, true), false, 'a forced insert one column later');
  assert.deepEqual(h.acceptEdit(8, 12, 12, 12, 3, CLOSED, true), [8, 15]);
  assert.deepEqual(h.acceptEdit(8, 12, 12, 12, 3, CLOSED), [8, 12]);
});

test('mayForceMove: a change touching a caret, read before or after the edit, is typing', () => {
  const caret = (l, c) => ({ start: P(l, c), end: P(l, c) });
  assert.equal(mayForceMove(change(2, 4, 2, 4, 'x'), [caret(2, 4)]), false, 'a key, caret read before');
  assert.equal(mayForceMove(change(2, 4, 2, 4, 'x'), [caret(2, 5)]), false, 'a key, caret read after');
  assert.equal(mayForceMove(change(2, 3, 2, 4, ''), [caret(2, 4)]), false, 'backspace');
  assert.equal(mayForceMove(change(2, 4, 2, 9, 'y'), [{ start: P(2, 4), end: P(2, 9) }]), false, 'typing over a selection');
  assert.equal(mayForceMove(change(2, 4, 2, 4, '\n    '), [caret(3, 4)]), false, 'Enter with indent, caret read after');
  assert.equal(mayForceMove(change(1, 0, 1, 0, 'x'), [caret(0, 0), caret(1, 0)]), false, 'a second cursor');
  assert.equal(mayForceMove(change(2, 12, 2, 12, '.clone()'), [caret(2, 8)]), true, 'a quick fix elsewhere on the caret line');
  assert.equal(mayForceMove(change(2, 4, 2, 4, 'x'), [caret(5, 0)]), true, 'another line');
  assert.equal(mayForceMove(change(2, 4, 2, 4, 'x'), []), true, 'no caret in this document');
});

test('typing or undoing right after a mark re-sends nothing; a forced edit there re-sends it', async () => {
  // The forced answer costs a setDecorations call, so it is kept to edits that do
  // not read as typing. Undo carries its reason and applies unforced anywhere.
  const cfg = { docs: ['py'], provider: { python: { mode: 'none', latency: 0 } } };
  const cases = [
    ['typed', [{ t: 'caret', line: 8, character: 12, kind: 2, dt: 500 }, { t: 'type', text: '._x', dt: 3000 }], 1],
    ['undone', [
      { t: 'caret', line: 8, character: 12, kind: 2, dt: 500 },
      { t: 'deleteRange', length: 8, dt: 3000 },
      { t: 'caret', line: 4, character: 0, kind: 2, dt: 500 },
      { t: 'undo', dt: 3000 },
    ], 3],
    ['forced', [{ t: 'caret', line: 4, character: 0, kind: 2, dt: 500 },
      { t: 'foreign', op: 'append', line: 8, character: 12, text: '._x', dt: 3000 }], 1],
  ];
  h.enterFakeTime();
  try {
    const sent = {};
    for (const [how, events, at] of cases) {
      sent[how] = 0;
      const r = await h.runWalk(cfg, events, (i, ev, res, w) => {
        if (i !== at - 1) return;
        const ed = w.activeEditor();
        const set = ed.setDecorations;
        ed.setDecorations = (type, ranges) => {
          if (type === w.d.pool.self) sent[how]++;
          set(type, ranges);
        };
      });
      assert.equal(r.failure, null, r.failure && `${how}, step ${r.failure.step}: ${r.failure.diff}`);
    }
    assert.deepEqual(sent, { typed: 0, undone: 0, forced: 1 });
  } finally {
    h.exitFakeTime();
  }
});

test('rangesMovedBy never misses a move VS Code makes', () => {
  // VS Code's own update rule, in offsets (the harness's port), against the
  // position check, on random edits around random ranges. An edit taken for
  // forced may have been applied unforced, so a forced "unmoved" holds for both.
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const text = 'ab\ncdef\n\nghij kl\nm\n';
  const lineStarts = (t) => [0, ...[...t].flatMap((ch, i) => (ch === '\n' ? [i + 1] : []))];
  const pos = (t, off) => {
    const ls = lineStarts(t);
    let l = ls.length - 1;
    while (ls[l] > off) l--;
    return P(l, off - ls[l]);
  };
  const unmoved = { forced: 0, unforced: 0 };
  for (let i = 0; i < 20000; i++) {
    const a = Math.floor(rnd() * (text.length + 1));
    const b = Math.min(text.length, a + Math.floor(rnd() * 4));
    const s = Math.floor(rnd() * (text.length + 1));
    const e = Math.min(text.length, s + Math.floor(rnd() * 5));
    const ins = ['', 'x', 'xy', '\n', 'q\n', '\nz'][Math.floor(rnd() * 6)];
    const behavior = Math.floor(rnd() * 4);
    const forced = rnd() < 0.5;
    const ed = { range: { start: pos(text, s), end: pos(text, e) }, text: ins };
    if (rangesMovedBy(ed, [{ start: pos(text, a), end: pos(text, b) }], behavior, forced)) continue;
    unmoved[forced ? 'forced' : 'unforced']++;
    const after = text.slice(0, s) + ins + text.slice(e);
    for (const force of forced ? [true, false] : [false]) {
      const [na, nb] = h.acceptEdit(a, b, s, e, ins.length, behavior, force);
      assert.deepEqual([pos(after, na), pos(after, nb)], [pos(text, a), pos(text, b)],
        `range ${a}-${b}, edit ${s}-${e} ${JSON.stringify(ins)}, behaviour ${behavior}, force ${force}: VS Code moves it`);
    }
  }
  assert.ok(unmoved.forced > 2500 && unmoved.unforced > 2500, `${JSON.stringify(unmoved)} unmoved cases checked`);
});

test('the harness moves decorations the way VS Code does', () => {
  // ClosedClosed (1): typing at either edge does not widen it; OpenOpen (0) widens.
  assert.deepEqual(h.acceptEdit(4, 8, 8, 8, 1, 1), [4, 8]);
  assert.deepEqual(h.acceptEdit(4, 8, 4, 4, 1, 1), [5, 9]);
  assert.deepEqual(h.acceptEdit(4, 8, 8, 8, 1, 0), [4, 9]);
  assert.deepEqual(h.acceptEdit(4, 8, 4, 4, 1, 0), [4, 9]);
  // Deleting its text collapses it at the deletion; typing it back does not restore it.
  assert.deepEqual(h.acceptEdit(4, 8, 2, 10, 0, 1), [2, 2]);
  assert.deepEqual(h.acceptEdit(2, 2, 2, 2, 8, 1), [10, 10]);
  // Replacing it with text of the same length keeps it.
  assert.deepEqual(h.acceptEdit(4, 8, 4, 8, 4, 1), [4, 8]);
});
