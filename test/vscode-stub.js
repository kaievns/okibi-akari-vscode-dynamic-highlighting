'use strict';
// A minimal `vscode` module stub, installed into Node's require cache so
// `out/decorator.js` and `out/tokens.js` can be loaded in a plain `node --test` run.
//
// Why this exists: every bug the user had to report twice — `self` going white on
// relaxation to Survey, Rust format placeholders staying green — lived in the RENDER
// PATH, and the render path was the one part of the extension with no test coverage
// at all, because `decorator.ts` imports `vscode` and `vscode` only exists inside a
// real editor host. The pure modules (focus, classify, colors) were well covered, so
// the tests kept passing while the thing on screen was wrong.
//
// The stub records what `setDecorations` is called with, which is exactly the
// question those bugs turned on: *which decoration types carry ranges at each
// phase?* It is deliberately not a full fake — no layout, no rendering — just enough
// surface for the decorator to run and be observed.

class Position {
  constructor(line, character) { this.line = line; this.character = character; }
}
class Range {
  constructor(a, b, c, d) {
    if (a instanceof Position) { this.start = a; this.end = b; }
    else { this.start = new Position(a, b); this.end = new Position(c, d); }
  }
}
class Selection extends Range {
  constructor(a, b, c, d) { super(a, b, c, d); this.active = this.end; this.anchor = this.start; }
}
class EventEmitter {
  constructor() { this.listeners = []; }
  get event() { return (fn) => { this.listeners.push(fn); return { dispose() {} }; }; }
  fire(v) { for (const fn of this.listeners) fn(v); }
}

/** Every decoration type created, in creation order, with its options. */
const createdTypes = [];
/** type → the last ranges applied to it, per editor. */
const applied = new Map();

function createTextEditorDecorationType(options) {
  const type = { id: createdTypes.length, options, dispose() {} };
  createdTypes.push(type);
  return type;
}

class TextEditor {
  constructor(document, line = 0, character = 0) {
    this.document = document;
    this.selection = new Selection(line, character, line, character);
    this.selections = [this.selection];
    this.visibleRanges = [new Range(0, 0, document.lineCount, 0)];
  }
  setDecorations(type, ranges) { applied.set(type, ranges); }
}

class TextDocument {
  constructor(text, languageId, uri = 'file:///test') {
    this._text = text;
    this.languageId = languageId;
    this.version = 1;
    this.uri = { toString: () => uri, fsPath: uri.replace('file://', '') };
    this._lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') this._lineStarts.push(i + 1);
  }
  get lineCount() { return this._lineStarts.length; }
  getText() { return this._text; }
  positionAt(offset) {
    let lo = 0;
    for (let i = 0; i < this._lineStarts.length; i++) if (this._lineStarts[i] <= offset) lo = i;
    return new Position(lo, offset - this._lineStarts[lo]);
  }
  offsetAt(pos) { return this._lineStarts[pos.line] + pos.character; }
  lineAt(line) {
    const start = this._lineStarts[line];
    const end = line + 1 < this._lineStarts.length ? this._lineStarts[line + 1] - 1 : this._text.length;
    return { text: this._text.slice(start, end), range: new Range(line, 0, line, end - start) };
  }
}

const config = new Map();
/** command name → canned response, for the semantic-token / symbol providers. */
const lspResponses = {};
const vscodeStub = {
  Position, Range, Selection, EventEmitter,
  ThemeColor: class { constructor(id) { this.id = id; } },
  Uri: { parse: (s) => ({ toString: () => s }), file: (p) => ({ toString: () => `file://${p}`, fsPath: p }) },
  DecorationRangeBehavior: { ClosedClosed: 0, OpenOpen: 1, ClosedOpen: 2, OpenClosed: 3 },
  OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
  TextEditorSelectionChangeKind: { Keyboard: 1, Mouse: 2, Command: 3 },
  SymbolKind: { Function: 11, Method: 5, Constructor: 8 },
  CancellationTokenSource: class {
    constructor() { this.token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }; }
    cancel() { this.token.isCancellationRequested = true; }
    dispose() {}
  },
  window: {
    activeTextEditor: undefined,
    visibleTextEditors: [],
    activeColorTheme: { kind: 2 },
    createTextEditorDecorationType,
    createStatusBarItem: () => ({ text: '', tooltip: '', command: '', show() {}, hide() {}, dispose() {} }),
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    onDidChangeActiveTextEditor: new EventEmitter().event,
    onDidChangeActiveColorTheme: new EventEmitter().event,
    onDidChangeTextEditorSelection: new EventEmitter().event,
    onDidChangeVisibleTextEditors: new EventEmitter().event,
    showInformationMessage() {},
  },
  workspace: {
    getConfiguration: () => ({ get: (key, dflt) => (config.has(key) ? config.get(key) : dflt) }),
    onDidChangeTextDocument: new EventEmitter().event,
    onDidChangeConfiguration: new EventEmitter().event,
    onDidCloseTextDocument: new EventEmitter().event,
    textDocuments: [],
  },
  commands: {
    registerCommand: () => ({ dispose() {} }),
    // Serves whatever `setLspResponses` installed. This is what lets a test drive the
    // FULL async cycle — refresh → classify → repaint — instead of only the
    // synchronous render. The blinking bug lived in that cycle, so a stub that always
    // returned undefined could never see it: runClassify bailed and the repaint that
    // followed a real classification never happened.
    executeCommand: async (cmd, ...args) => lspResponses[cmd],
  },
  languages: { registerDocumentSemanticTokensProvider: () => ({ dispose() {} }) },
};

/** Install the stub so `require('vscode')` resolves to it. */
function install() {
  const Module = require('module');
  const original = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'vscode') return 'vscode';
    return original.call(this, request, ...rest);
  };
  require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscodeStub };
  return vscodeStub;
}

module.exports = {
  install, vscodeStub, createdTypes, applied,
  TextDocument, TextEditor, Position, Range, Selection,
  setConfig: (k, v) => config.set(k, v),
  /**
   * Install canned language-server responses. Pass a decoded fixture and it is
   * re-encoded into the LSP delta wire format, because that is what the extension
   * decodes — testing against the decoded form would skip `decodeSemanticTokens`,
   * which is exactly the kind of gap that let these bugs through.
   */
  setLspResponses: (map) => Object.assign(lspResponses, map),
  clearLspResponses: () => { for (const k of Object.keys(lspResponses)) delete lspResponses[k]; },
  resetApplied: () => applied.clear(),
};
