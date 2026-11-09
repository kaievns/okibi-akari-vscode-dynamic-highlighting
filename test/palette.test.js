'use strict';
// Band-2 identity palette invariants (TOKENS.id) and the escape mark's distance
// from the error colour. Method, thresholds and colour maths: docs/palette.md.

const { test } = require('node:test');
const assert = require('node:assert/strict');

require('./vscode-stub').install();
const { TOKENS } = require('../out/tokens');

// The theme's editorError.foreground (spec --err), which this repo does not carry.
const ERR = { dark: '#f84f52', light: '#c71529' };

const CHROMA_TOLERANCE = 0.003;
const CHROMA_CEILING = 0.12;
const FP_SPREAD_MAX = 2.5;
const WCAG_MIN = 4.5;
const DELTA_E_MIN = 0.06;
const ERR_HUE_GAP_MIN = 30;

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function linearRgb(hex) {
  assert.match(hex, /^#[0-9a-f]{6}$/i, `${hex} is a 6-digit hex`);
  return [1, 3, 5].map((i) => toLinear(parseInt(hex.slice(i, i + 2), 16) / 255));
}

function oklab(hex) {
  const [r, g, b] = linearRgb(hex);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function lch([L, a, b]) {
  const h = (Math.atan2(b, a) * 180) / Math.PI;
  return { L, C: Math.hypot(a, b), h: h < 0 ? h + 360 : h };
}

const oklch = (hex) => lch(oklab(hex));

function deltaEOk(x, y) {
  const p = oklab(x);
  const q = oklab(y);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

function cielch(hex) {
  const [r, g, b] = linearRgb(hex);
  const X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const Z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const fx = f(X / 0.95047);
  const fy = f(Y / 1.0);
  const fz = f(Z / 1.08883);
  return lch([116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]);
}

// Fairchild & Pirrotta 1991: L** = L* + (2.5 - 0.025 L*)(0.116 |sin((h - 90) / 2)| + 0.085) C*.
function perceivedLightness(hex) {
  const { L, C, h } = cielch(hex);
  const hueTerm = 0.116 * Math.abs(Math.sin((((h - 90) / 2) * Math.PI) / 180)) + 0.085;
  return L + (2.5 - 0.025 * L) * hueTerm * C;
}

function luminance(hex) {
  const [r, g, b] = linearRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(x, y) {
  const a = luminance(x);
  const b = luminance(y);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function hueGap(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

const spread = (xs) => Math.max(...xs) - Math.min(...xs);
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

const THEMES = [
  ['Okibi', 'dark'],
  ['Akari', 'light'],
];

test('palette maths: reference values', () => {
  const call = oklch('#6eaff7'); // spec --syn-call oklch(0.74 0.125 252)
  assert.ok(Math.abs(call.L - 0.74) < 0.002 && Math.abs(call.C - 0.125) < 0.002 && Math.abs(call.h - 252) < 0.5, JSON.stringify(call));
  assert.ok(Math.abs(contrast('#000000', '#ffffff') - 21) < 1e-9);
  assert.ok(Math.abs(cielch('#ffffff').L - 100) < 1e-3);
  assert.ok(Math.abs(perceivedLightness('#808080') - cielch('#808080').L) < 0.1, 'a grey has no H-K boost');
  assert.ok(perceivedLightness('#ff00ff') > cielch('#ff00ff').L + 10, 'a saturated magenta reads brighter than its L*');
});

for (const [name, side] of THEMES) {
  const tints = TOKENS.id.map((p) => p[side]);
  const ground = TOKENS.n2[side];

  test(`${name} palette: five tints, all distinct`, () => {
    assert.equal(tints.length, 5);
    assert.equal(new Set(tints.map((t) => t.toLowerCase())).size, 5);
  });

  test(`${name} palette: one OKLCH chroma, at most ${CHROMA_CEILING}`, () => {
    const C = tints.map((t) => oklch(t).C);
    const m = mean(C);
    for (const [i, c] of C.entries()) {
      assert.ok(Math.abs(c - m) <= CHROMA_TOLERANCE, `${tints[i]} C ${c.toFixed(3)} vs mean ${m.toFixed(3)}`);
    }
    assert.ok(m <= CHROMA_CEILING, `mean C ${m.toFixed(3)}`);
  });

  test(`${name} palette: even perceived lightness (Fairchild-Pirrotta spread <= ${FP_SPREAD_MAX})`, () => {
    const Lpp = tints.map(perceivedLightness);
    assert.ok(spread(Lpp) <= FP_SPREAD_MAX, `L** ${Lpp.map((x) => x.toFixed(1)).join(' ')}`);
  });

  test(`${name} palette: every tint clears WCAG ${WCAG_MIN}:1 on the editor ground`, () => {
    for (const t of tints) {
      const c = contrast(t, ground);
      assert.ok(c >= WCAG_MIN, `${t} on ${ground}: ${c.toFixed(2)}:1`);
    }
  });

  test(`${name} palette: closest pair at least ${DELTA_E_MIN} apart (deltaE OK)`, () => {
    for (let i = 0; i < tints.length; i++) {
      for (let j = i + 1; j < tints.length; j++) {
        const d = deltaEOk(tints[i], tints[j]);
        assert.ok(d >= DELTA_E_MIN, `${tints[i]} / ${tints[j]}: ${d.toFixed(3)}`);
      }
    }
  });

  test(`${name}: escape and async marks sit at least ${ERR_HUE_GAP_MIN} degrees of hue from the error colour`, () => {
    for (const key of ['riskEscape', 'riskAsync']) {
      const c = TOKENS[key][side];
      const gap = hueGap(oklch(c).h, oklch(ERR[side]).h);
      assert.ok(gap >= ERR_HUE_GAP_MIN, `${key} ${c} vs ${ERR[side]}: ${gap.toFixed(1)} degrees`);
    }
  });
}
