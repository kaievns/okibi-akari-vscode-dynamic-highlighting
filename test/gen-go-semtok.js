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

const out = [];
for (const mk of markers) {
  // ⇒ : token starts AT the marker position (marker precedes token).
  // ⇐ : token ENDS at the marker position (marker follows token).
  const offset = mk.dir === '⇒' ? mk.cleanPos : mk.cleanPos - mk.len;
  const name = src.substr(offset, mk.len);
  out.push({ name, offset, length: mk.len, type: mk.type, modifiers: mk.mods });
}

out.sort((a, b) => a.offset - b.offset);

const bad = out.filter((t) => src.substr(t.offset, t.length) !== t.name);
if (bad.length) {
  console.error(`MISMATCH: ${bad.length}/${out.length} tokens failed offset verification`);
  console.error(bad.slice(0, 5));
  process.exit(1);
}
console.log(JSON.stringify(out, null, 0));
