'use strict';
// Transitions: seeded random walks over editor events, each step compared with a
// fresh Decorator given the same final state. A difference is a leftover of an
// earlier state. Model and oracle: docs/runtime.md#transitions.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./transitions-harness');
const { mayForceMove, positionMovedBy, rangesMovedBy } = require('../out/tracking');
const { Phase } = require('../out/phases');
const html = require('../out/html');
const sfc = require('../out/sfc');
const php = require('../out/php');
const focus = require('../out/focus');
const { Position } = require('./vscode-stub');

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

const SHELL_WALKS = Number(process.env.OKIBI_SHELL_WALKS ?? 120);

test(`${SHELL_WALKS} random walks over walk.sh, walk.zsh and walk.fish beside the tooling files leave no leftovers`, async (t) => {
  const shown = { tint: 0, clay: 0, riskDanger: 0, tooling: 0 };
  const tooling = new Set(h.TOOLING_KEYS);
  await walks(h.generateShell, SHELL_WALKS, STEPS, SEED0, 1 / 2, (i, ev, r, w) => {
    const sh = r.got.editors.find((e) => /\.(sh|zsh|fish)$/.test(e.uri));
    const roles = new Set(Object.keys(sh?.out ?? {}).map((k) => k.split(' ')[0]));
    if ([...roles].some((x) => /^(id|idg)\d$/.test(x))) shown.tint++;
    if (roles.has('numberEngaged')) shown.clay++;
    if (roles.has('riskDanger')) shown.riskDanger++;
    if (tooling.has(w.activeEditor()?.document.fileName.split('.').pop())) shown.tooling++;
  });
  const seen = Object.entries(shown).map(([k, n]) => `${k} ${n}`).join(', ');
  if (DEFAULT_RUN && SHELL_WALKS === 120) for (const [k, n] of Object.entries(shown)) assert.ok(n > 0, `${k}: ${seen}`);
  t.diagnostic(`the shell files painted, in steps: ${seen}`);
});

test(`${SHELL_WALKS} walks that unclose and reclose a heredoc, a quote, a block word or a hole in walk.sh and walk.fish leave no leftovers`, () =>
  walks(h.generateShellReclose, SHELL_WALKS, RECLOSE_STEPS, SEED0, 1 / 4));

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

const HTML_WALKS = Number(process.env.OKIBI_HTML_WALKS ?? 120);

/** The first paint of an HTML editor outside every script of its text, else null: a stripe line must hold script text. */
function paintOutsideScripts(doc, out) {
  const regions = html.scriptRegions(doc.getText());
  const inside = (o) => regions.some((r) => o >= r.start && o <= r.end);
  for (const [key, ranges] of Object.entries(out)) {
    const role = key.split(' ')[0];
    for (const [s, e] of ranges) {
      if (role !== 'gutter' && inside(s) && inside(e)) continue;
      if (role === 'gutter') {
        const ls = doc.offsetAt(new Position(s, 0));
        const le = ls + doc.lineAt(s).text.length;
        if (regions.some((r) => r.start <= le && r.end >= ls)) continue;
      }
      return `${role} at ${s}-${e}`;
    }
  }
  return null;
}

test(`${HTML_WALKS} random walks over walk.html leave no leftovers and paint nothing outside a script`, async (t) => {
  const shown = { tint: 0, clay: 0, importRestore: 0, riskEscape: 0, self: 0, riskAsync: 0, gutter: 0 };
  const active = Object.fromEntries(h.WEB_KEYS.map((k) => [h.FIXTURES[k].lang, 0]));
  const outside = [];
  await walks(h.generateHtml, HTML_WALKS, STEPS, SEED0, 1 / 2, (i, ev, r, w) => {
    const lang = w.activeEditor()?.document.languageId;
    if (lang in active) active[lang]++;
    const roles = new Set();
    w.visible().forEach((ed, j) => {
      if (ed.document.languageId !== 'html') return;
      const out = r.got.editors[j].out;
      const bad = paintOutsideScripts(ed.document, out);
      if (bad) outside.push(`step ${i}, v${ed.document.version}: ${bad}`);
      for (const k of Object.keys(out)) roles.add(k.split(' ')[0]);
    });
    if ([...roles].some((x) => /^(id|idg)\d$/.test(x))) shown.tint++;
    if (roles.has('numberEngaged')) shown.clay++;
    if (roles.has('gutter')) shown.gutter++;
    for (const k of ['importRestore', 'riskEscape', 'self', 'riskAsync']) if (roles.has(k)) shown[k]++;
  });
  assert.deepEqual(outside.slice(0, 5), []);
  const seen = `${Object.entries(shown).map(([k, n]) => `${k} ${n}`).join(', ')}; active: ${Object.entries(active).map(([l, n]) => `${l} ${n}`).join(', ')}`;
  if (DEFAULT_RUN && HTML_WALKS === 120) for (const [k, n] of [...Object.entries(shown), ...Object.entries(active)]) assert.ok(n > 0, `${k}: ${seen}`);
  t.diagnostic(`walk.html painted, in steps: ${seen}`);
});

const COMPONENT_WALKS = Number(process.env.OKIBI_COMPONENT_WALKS ?? 120);

/**
 * The first paint of a component editor outside every code region of its text, else
 * null. A stripe line may hold markup only inside a template block around the region
 * that holds the caret: the block is focused whole (docs/components.md § Blocks and focus).
 */
function paintOutsideRegions(doc, out, caret) {
  const view = html.flowText(doc.getText(), doc.languageId);
  const component = sfc.COMPONENT_LANGUAGES.has(doc.languageId);
  const regions = component ? html.viewRegions(view) : [{ start: 0, end: view.length }];
  const inside = (o) => regions.some((r) => o >= r.start && o <= r.end);
  const home = regions.find((r) => caret >= r.start && caret <= r.end);
  const blockLines = !component || !home ? [] : html.viewBlocks(view)
    .filter((b) => b.open <= home.start && home.end <= b.close + 1)
    .map((b) => [doc.positionAt(b.open).line, doc.positionAt(b.close).line]);
  for (const [key, ranges] of Object.entries(out)) {
    const role = key.split(' ')[0];
    for (const [s, e] of ranges) {
      if (role !== 'gutter' && inside(s) && inside(e)) continue;
      if (role === 'gutter') {
        const ls = doc.offsetAt(new Position(s, 0));
        const le = ls + doc.lineAt(s).text.length;
        if (regions.some((r) => r.start <= le && r.end >= ls)) continue;
        if (blockLines.some(([a, z]) => s >= a && s <= z)) continue;
      }
      return `${role} at ${s}-${e}`;
    }
  }
  return null;
}

test(`${COMPONENT_WALKS} random walks over walk.vue, walk.svelte, walk.astro, walk.tsx and walk.jsx leave no leftovers and paint nothing outside a code region`, async (t) => {
  const shown = { tint: 0, clay: 0, importRestore: 0, riskEscape: 0, self: 0, gutter: 0, jsxPlaceholder: 0, jsxCommentRestore: 0 };
  const active = Object.fromEntries(h.COMPONENT_KEYS.map((k) => [h.FIXTURES[k].lang, 0]));
  const outside = [];
  await walks(h.generateComponents, COMPONENT_WALKS, STEPS, SEED0, 1 / 2, (i, ev, r, w) => {
    const lang = w.activeEditor()?.document.languageId;
    if (lang in active) active[lang]++;
    const roles = new Set();
    w.visible().forEach((ed, j) => {
      if (!(ed.document.languageId in active)) return;
      const out = r.got.editors[j].out;
      const bad = paintOutsideRegions(ed.document, out, ed.document.offsetAt(ed.selection.active));
      if (bad) outside.push(`step ${i}, ${ed.document.languageId} v${ed.document.version}: ${bad}`);
      for (const k of Object.keys(out)) roles.add(k.split(' ')[0]);
      if (ed.document.languageId !== 'javascriptreact') return;
      for (const k of ['placeholder', 'commentRestore']) if (Object.keys(out).some((x) => x.split(' ')[0] === k)) roles.add(`jsx:${k}`);
    });
    if ([...roles].some((x) => /^(id|idg)\d$/.test(x))) shown.tint++;
    if (roles.has('numberEngaged')) shown.clay++;
    if (roles.has('gutter')) shown.gutter++;
    if (roles.has('jsx:placeholder')) shown.jsxPlaceholder++;
    if (roles.has('jsx:commentRestore')) shown.jsxCommentRestore++;
    for (const k of ['importRestore', 'riskEscape', 'self']) if (roles.has(k)) shown[k]++;
  });
  assert.deepEqual(outside.slice(0, 5), []);
  const seen = `${Object.entries(shown).map(([k, n]) => `${k} ${n}`).join(', ')}; active: ${Object.entries(active).map(([l, n]) => `${l} ${n}`).join(', ')}`;
  if (DEFAULT_RUN && COMPONENT_WALKS === 120) for (const [k, n] of [...Object.entries(shown), ...Object.entries(active)]) assert.ok(n > 0, `${k}: ${seen}`);
  t.diagnostic(`components painted, in steps: ${seen}`);
});

/** The stripe lines of a component editor that touch no code region. */
function markupStripeLines(doc, out) {
  const regions = html.viewRegions(html.flowText(doc.getText(), doc.languageId));
  return Object.entries(out).filter(([k]) => k.split(' ')[0] === 'gutter').flatMap(([, v]) => v).filter(([s]) => {
    const ls = doc.offsetAt(new Position(s, 0));
    const le = ls + doc.lineAt(s).text.length;
    return !regions.some((r) => r.start <= le && r.end >= ls);
  }).length;
}

test('a stripe over a focused {#await} block\'s markup lines is the block\'s: seed 4753 of the walks over the first four components', async () => {
  const outside = [];
  let markupLines = 0;
  const firstFour = (seed, steps) => h.generateComponents(seed, steps, ['vue', 'svelte', 'astro', 'tsx']);
  await walks(firstFour, 1, 60, 4753, 0, (i, ev, r, w) => {
    w.visible().forEach((ed, j) => {
      if (!sfc.COMPONENT_LANGUAGES.has(ed.document.languageId)) return;
      const out = r.got.editors[j].out;
      const bad = paintOutsideRegions(ed.document, out, ed.document.offsetAt(ed.selection.active));
      if (bad) outside.push(`step ${i}, ${ed.document.languageId} v${ed.document.version}: ${bad}`);
      markupLines += markupStripeLines(ed.document, out);
    });
  });
  assert.deepEqual(outside, []);
  assert.ok(markupLines > 0, 'the walk stripes a markup-only line of the focused block');
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

const CJVM_WALKS = Number(process.env.OKIBI_CJVM_WALKS ?? 120);

test(`${CJVM_WALKS} random walks over walk.c, walk.cpp, walk.java, walk.kt and walk.groovy, with CMake and Gradle scripts, leave no leftovers`, async (t) => {
  const shown = { tint: 0, clay: 0, riskEscape: 0, riskDanger: 0, self: 0, constantRestore: 0, ktTemplate: 0 };
  await walks(h.generateCjvm, CJVM_WALKS, STEPS, SEED0, 1 / 2, (i, ev, r, w) => {
    for (const e of r.got.editors) {
      if (!/\.(c|cpp|java|kt|groovy)$/.test(e.uri)) continue;
      const roles = new Set(Object.keys(e.out ?? {}).map((k) => k.split(' ')[0]));
      if ([...roles].some((x) => /^(id|idg)\d$/.test(x))) shown.tint++;
      if (roles.has('numberEngaged')) shown.clay++;
      for (const k of ['riskEscape', 'riskDanger', 'self']) if (roles.has(k)) shown[k]++;
      if (e.uri.endsWith('.c')) {
        const text = w.docs.find((d) => d.uri.toString() === e.uri).getText();
        const words = Object.entries(e.out ?? {}).filter(([k]) => k.startsWith('self ')).flatMap(([, iv]) => iv.map(([a, b]) => text.slice(a, b)));
        assert.ok(words.every((x) => x === 'bool'), `step ${i}: C has no receiver keyword; its keyword-grey restore is \`bool\` alone: ${words.join(' ')}`);
      }
      if (roles.has('constantRestore')) shown.constantRestore++;
      if (e.uri.endsWith('.kt') && roles.has('placeholder')) shown.ktTemplate++;
    }
  });
  const seen = Object.entries(shown).map(([k, n]) => `${k} ${n}`).join(', ');
  if (DEFAULT_RUN && CJVM_WALKS === 120) for (const [k, n] of Object.entries(shown)) assert.ok(n > 0, `${k}: ${seen}`);
  t.diagnostic(`C, C++, Java, Kotlin and Groovy painted, in steps: ${seen}`);
});

const SWIFT_WALKS = Number(process.env.OKIBI_SWIFT_WALKS ?? 120);

test(`${SWIFT_WALKS} random walks over walk.swift, walk.m as Objective-C and Objective-C++, walk.h as cpp and walk.metal, with strings, pbxproj, xcconfig and plist files, leave no leftovers`, async (t) => {
  const shown = {
    tint: 0, clay: 0, riskEscape: 0, riskDanger: 0, self: 0, swiftTint: 0, objcTint: 0, objcppTint: 0, objchTint: 0, metalTint: 0,
    operatorRestore: 0, bracketRestore: 0, attributeRestore: 0, callRestore: 0, objcConstant: 0,
  };
  await walks(h.generateSwift, SWIFT_WALKS, STEPS, SEED0, 1 / 2, (i, ev, r) => {
    for (const e of r.got.editors) {
      const roles = new Set(Object.keys(e.out ?? {}).map((k) => k.split(' ')[0]));
      if (/\.(strings|pbxproj|xcconfig|plist|plist-xml)$/.test(e.uri)) {
        assert.equal(roles.size, 0, `step ${i}: ${e.uri} is static content and paints nothing: ${[...roles].join(' ')}`);
        continue;
      }
      if (!/\.(swift|objc|objcpp|objch|metal)$/.test(e.uri)) continue;
      const tinted = [...roles].some((x) => /^(id|idg)\d$/.test(x));
      if (tinted) shown.tint++;
      if (tinted && e.uri.endsWith('.swift')) shown.swiftTint++;
      if (tinted && e.uri.endsWith('.objc')) shown.objcTint++;
      if (tinted && e.uri.endsWith('.objcpp')) shown.objcppTint++;
      if (tinted && e.uri.endsWith('.objch')) shown.objchTint++;
      if (tinted && e.uri.endsWith('.metal')) shown.metalTint++;
      if (roles.has('numberEngaged')) shown.clay++;
      for (const k of ['riskEscape', 'riskDanger', 'self']) if (roles.has(k)) shown[k]++;
      for (const k of ['operatorRestore', 'bracketRestore', 'attributeRestore', 'callRestore']) {
        if (!roles.has(k)) continue;
        assert.ok(e.uri.endsWith('.swift'), `step ${i}: ${k} is Swift's alone: ${e.uri}`);
        shown[k]++;
      }
      if (e.uri.endsWith('.objc') && roles.has('constantRestore')) shown.objcConstant++;
    }
  });
  const seen = Object.entries(shown).map(([k, n]) => `${k} ${n}`).join(', ');
  if (DEFAULT_RUN && SWIFT_WALKS === 120) for (const [k, n] of Object.entries(shown)) assert.ok(n > 0, `${k}: ${seen}`);
  t.diagnostic(`Swift, Objective-C, Objective-C++, a header and Metal painted, in steps: ${seen}`);
});

const CANCEL_WALKS = Number(process.env.OKIBI_CANCEL_WALKS ?? 80);

test(`${CANCEL_WALKS} random walks over walk.c and walk.cpp, cpptools cancelling the companion's requests, clangd or no server, leave no leftovers`, async (t) => {
  const byServer = { cpptools: { steps: 0, tint: 0, held: 0 }, clangd: { steps: 0, tint: 0, held: 0 }, none: { steps: 0, tint: 0, held: 0 } };
  let cancelled = 0;
  let last = null;
  await walks(h.generateCjvmCancel, CANCEL_WALKS, STEPS, SEED0, 1 / 4, (i, ev, r, w) => {
    const s = byServer[w.cfg.server];
    s.steps++;
    if (r.got.editors.some((e) => /\.(c|cpp)$/.test(e.uri) && Object.keys(e.out ?? {}).some((k) => /^(id|idg)\d /.test(k)))) s.tint++;
    // A cancelled request is superseded, not an empty answer: band 2 never holds on one.
    if ([...w.d.classCache.values()].some((e) => e.hold)) s.held++;
    if (w !== last) {
      cancelled += last?.cancelled ?? 0;
      last = w;
    }
  });
  cancelled += last?.cancelled ?? 0;
  const seen = Object.entries(byServer).map(([k, v]) => `${k} ${v.tint} of ${v.steps}`).join(', ');
  assert.equal(byServer.cpptools.held, 0, `steps holding band 2 under cpptools: ${byServer.cpptools.held}`);
  if (DEFAULT_RUN && CANCEL_WALKS === 80) {
    for (const [k, v] of Object.entries(byServer)) assert.ok(v.tint > 0, `${k}: ${seen}`);
    assert.ok(cancelled > 50, `cpptools cancelled ${cancelled} requests`);
  }
  t.diagnostic(`steps with a tint: ${seen}; requests cancelled: ${cancelled}`);
});

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

const SHEET_WALKS = Number(process.env.OKIBI_SHEET_WALKS ?? 120);

test(`${SHEET_WALKS} random walks over the stylesheets, GraphQL and Razor files beside a code file leave no leftovers`, async (t) => {
  const active = Object.fromEntries(h.SHEET_KEYS.map((k) => [h.FIXTURES[k].lang, 0]));
  let beside = 0;
  await walks(h.generateSheets, SHEET_WALKS, STEPS, SEED0, 1 / 2, (i, ev, r, w) => {
    const lang = w.activeEditor()?.document.languageId;
    if (lang in active) active[lang]++;
    const shown = w.visible().map((ed, j) => [ed.document.languageId, Object.keys(r.got.editors[j].out).map((k) => k.split(' ')[0])]);
    if (shown.some(([l]) => l in active) && shown.some(([, roles]) => roles.some((x) => x === 'gutter' || /^id/.test(x)))) beside++;
  });
  const seen = `active: ${Object.entries(active).map(([l, n]) => `${l} ${n}`).join(', ')}; a sheet on screen beside a painted code file at ${beside} steps`;
  if (DEFAULT_RUN && SHEET_WALKS === 120) for (const [l, n] of Object.entries(active)) assert.ok(n > 0, `${l}: ${seen}`);
  t.diagnostic(seen);
});

const PHP_WALKS = Number(process.env.OKIBI_PHP_WALKS ?? 120);

/**
 * The first paint of a PHP editor outside every PHP region of its text, else null. A
 * stripe line holds PHP, or markup inside a block whose braces sit in two regions
 * (`<?php if ($x) { ?> … <?php } ?>`), which the stripe covers whole (docs/php.md).
 */
function paintOutsidePhp(doc, out) {
  const regions = php.phpRegions(doc.getText());
  const inside = (o) => regions.some((r) => o >= r.start && o <= r.end);
  const regionOf = (o) => regions.findIndex((r) => o >= r.start && o <= r.end);
  const bridged = focus.scanBlocks(html.flowText(doc.getText(), 'php'), 'php')
    .filter((b) => regionOf(b.openOffset) !== regionOf(b.closeOffset))
    .map((b) => [b.openLine, b.closeLine]);
  for (const [key, ranges] of Object.entries(out)) {
    const role = key.split(' ')[0];
    for (const [s, e] of ranges) {
      if (role !== 'gutter' && inside(s) && inside(e)) continue;
      if (role === 'gutter') {
        const ls = doc.offsetAt(new Position(s, 0));
        const le = ls + doc.lineAt(s).text.length;
        if (regions.some((r) => r.start <= le && r.end >= ls)) continue;
        if (bridged.some(([a, z]) => s >= a && s <= z)) continue;
      }
      return `${role} at ${s}-${e}`;
    }
  }
  return null;
}

test(`${PHP_WALKS} random walks over walk.php leave no leftovers and paint nothing outside a PHP region`, async (t) => {
  const shown = { tint: 0, clay: 0, gutter: 0, self: 0, riskAsync: 0 };
  const outside = [];
  await walks(h.generatePhp, PHP_WALKS, STEPS, SEED0, 1 / 2, (i, ev, r, w) => {
    const roles = new Set();
    w.visible().forEach((ed, j) => {
      if (ed.document.languageId !== 'php') return;
      const out = r.got.editors[j].out;
      const bad = paintOutsidePhp(ed.document, out);
      if (bad) outside.push(`step ${i}, v${ed.document.version}: ${bad}`);
      for (const k of Object.keys(out)) roles.add(k.split(' ')[0]);
    });
    if ([...roles].some((x) => /^(id|idg)\d$/.test(x))) shown.tint++;
    if (roles.has('numberEngaged')) shown.clay++;
    if (roles.has('gutter')) shown.gutter++;
    for (const k of ['self', 'riskAsync']) if (roles.has(k)) shown[k]++;
  });
  assert.deepEqual(outside.slice(0, 5), []);
  assert.equal(shown.self + shown.riskAsync, 0, `walk.php paints no self restore and no async mark: ${JSON.stringify(shown)}`);
  if (DEFAULT_RUN && PHP_WALKS === 120) for (const k of ['tint', 'clay', 'gutter']) assert.ok(shown[k] > 0, `${k}: ${JSON.stringify(shown)}`);
  t.diagnostic(`walk.php painted, in steps: ${JSON.stringify(shown)}`);
});

const MDX_WALKS = Number(process.env.OKIBI_MDX_WALKS ?? 120);

test(`${MDX_WALKS} random walks over walk.mdx leave no leftovers and paint only the link-underline cancel there`, async (t) => {
  const shown = { mdHighlight: 0, mdLinkPlain: 0 };
  let active = 0;
  await walks(h.generateMdx, MDX_WALKS, STEPS, SEED0, 1 / 2, (i, ev, r, w) => {
    if (w.activeEditor()?.document.languageId === 'mdx') active++;
    w.visible().forEach((ed, j) => {
      if (ed.document.languageId !== 'mdx') return;
      for (const k of Object.keys(r.got.editors[j].out)) if (k.split(' ')[0] in shown) shown[k.split(' ')[0]]++;
    });
  });
  assert.equal(shown.mdHighlight, 0, 'MDX has no wash: the theme scopes no ==highlight== there');
  if (DEFAULT_RUN && MDX_WALKS === 120) for (const [k, n] of Object.entries({ link: shown.mdLinkPlain, active })) assert.ok(n > 0, `${k}: ${JSON.stringify({ ...shown, active })}`);
  t.diagnostic(`walk.mdx: ${JSON.stringify({ ...shown, active })}`);
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
for (const key of [...h.DATA_KEYS, ...h.CONTAINER_KEYS, ...h.WEB_KEYS, ...h.SHEET_KEYS, 'zon', ...h.PROSE_KEYS, 'mdx']) test(`switching between a code file in Edit and a ${key} file leaves ${h.FIXTURES[key].marks === 'link' ? 'only the link-underline cancel' : h.FIXTURES[key].marks ? 'only the markdown marks' : 'nothing'} on the ${key} file`, async () => {
  const lang = h.FIXTURES[key].lang;
  const shows = h.FIXTURES[key].marks === 'link' ? ['mdLinkPlain'] : h.FIXTURES[key].marks ? MD_MARKS : [];
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
