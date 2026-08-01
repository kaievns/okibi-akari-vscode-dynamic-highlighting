// Convert `gopls semtok <file>` inline-annotated output into JSON DecodedToken[]
// with absolute offsets. Ground-truth fixtures for classification tests.
//   ~/go/bin/gopls semtok <file.go> | node test/gen-go-semtok.js <file.go> > out.json
//
// Approach: gopls prints the ORIGINAL source with inline markers inserted. If we
// strip the markers, we get the source back verbatim — so an offset into the
// marker-stripped text IS the real source offset. We rebuild the clean text and
// each token's offset together, in one pass, so multi-byte characters in
// comments can never desync us (we count real characters, not gopls's lengths).
//
//   /*⇒LEN,TYPE,[MODS]*/  precedes its token
//   /*⇐LEN,TYPE,[MODS]*/  follows its token
const fs = require('fs');
const srcFile = process.argv[2];
const src = fs.readFileSync(srcFile, 'utf8');
const annotated = fs.readFileSync(0, 'utf8'); // stdin

const MARKER = /\/\*(⇒|⇐)(\d+),([a-zA-Z]+),\[([^\]]*)\]\*\//g;

// Rebuild the clean source while recording, for each marker, the clean-text
// offset at the marker's position. Then pair markers with token text.
let clean = '';
let lastEnd = 0;
const markers = []; // {dir, len, type, mods, cleanPos}
let m;
MARKER.lastIndex = 0;
while ((m = MARKER.exec(annotated)) !== null) {
  clean += annotated.slice(lastEnd, m.index); // literal text between markers
  markers.push({
    dir: m[1],
    len: +m[2],
    type: m[3],
    mods: m[4] ? m[4].split(' ') : [],
    cleanPos: clean.length, // offset in clean text where this marker sits
  });
  lastEnd = MARKER.lastIndex;
}
clean += annotated.slice(lastEnd);

// Sanity: the reconstructed clean text must equal the original source. If not,
// the annotated format changed — fail loudly rather than emit drifted offsets.
if (clean !== src) {
  const at = [...clean].findIndex((c, i) => c !== src[i]);
  console.error(`Reconstructed text != source (first diff at ${at}). Fixture generator needs updating.`);
  process.exit(1);
}

/**
 * Types whose text is a bare identifier. Only these can be shape-checked: a
 * `string` token legitimately contains quotes, and a `comment` contains anything.
 */
const IDENT_TYPES = new Set([
  'namespace', 'type', 'parameter', 'variable', 'property',
  'function', 'method', 'member', 'keyword', 'label',
]);

/** Does `src[offset, offset+len)` sit on a whole identifier? */
function isWholeWord(offset, len, type) {
  if (offset < 0 || offset + len > src.length) {
    return false;
  }
  if (type !== undefined && !IDENT_TYPES.has(type)) {
    return true; // strings, comments, numbers, operators — shape check not meaningful
  }
  const body = src.substr(offset, len);
  // An identifier must not contain a quote; that is the signature of an
  // off-by-one landing across a string boundary.
  if (/["'`]/.test(body)) {
    return false;
  }
  const before = offset > 0 ? src[offset - 1] : '';
  const after = offset + len < src.length ? src[offset + len] : '';
  const idChar = /[A-Za-z0-9_]/;
  if (idChar.test(before) && idChar.test(body[0])) {
    return false; // starts mid-identifier
  }
  if (idChar.test(after) && idChar.test(body[len - 1])) {
    return false; // ends mid-identifier
  }
  return true;
}

const out = [];
for (const mk of markers) {
  let offset;
  if (mk.dir === '⇒') {
    // Marker PRECEDES its token: the token starts right where the marker was.
    offset = mk.cleanPos;
  } else {
    // Marker FOLLOWS its token. Naively that means the token ends at cleanPos —
    // but for an import path gopls puts the marker after the CLOSING QUOTE while
    // reporting only the identifier inside it, so the true end is one char
    // earlier. Probe both and take whichever lands on a whole word.
    //   "errors"/*⇐6,namespace*/   len 6, marker at 657, `errors` is at 650..656
    const endAtMarker = mk.cleanPos - mk.len;
    const endBeforeQuote = mk.cleanPos - 1 - mk.len;
    offset = isWholeWord(endAtMarker, mk.len, mk.type)
      ? endAtMarker
      : isWholeWord(endBeforeQuote, mk.len, mk.type)
        ? endBeforeQuote
        : endAtMarker; // neither fits — keep the naive value so the check below fails loudly
  }
  out.push({
    name: src.substr(offset, mk.len),
    offset,
    length: mk.len,
    type: mk.type,
    modifiers: mk.mods,
  });
}

out.sort((a, b) => a.offset - b.offset);

// NOTE: do NOT verify by re-slicing at the same offset — `name` was produced that
// way, so the comparison is vacuously true. That tautology is exactly why an
// off-by-one in the ⇐ branch shipped undetected: every token "verified" while
// `errors` was recorded as `rrors"`. Check the SHAPE instead.
const bad = out.filter((t) => !isWholeWord(t.offset, t.length, t.type));
if (bad.length) {
  console.error(`MISMATCH: ${bad.length}/${out.length} tokens are not whole words`);
  console.error(bad.slice(0, 8));
  process.exit(1);
}
console.log(JSON.stringify(out, null, 0));
