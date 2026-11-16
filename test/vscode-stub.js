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
  get event() {
    return (fn) => {
      this.listeners.push(fn);
      return { dispose: () => { this.listeners = this.listeners.filter((f) => f !== fn); } };
    };
  }
  fire(v) { for (const fn of [...this.listeners]) fn(v); }
}

/** A Uri-shaped object: `scheme` is what the decorator's allowlist reads. */
function makeUri(s) {
  const m = /^([a-zA-Z][\w+.-]*):/.exec(s);
  return { scheme: m ? m[1] : 'file', toString: () => s, fsPath: s.replace(/^[a-zA-Z][\w+.-]*:\/\//, '') };
}

/** Every decoration type created, in creation order, with its options. */
const createdTypes = [];
/** type → the last ranges applied to it, per editor. */
const applied = new Map();

function createTextEditorDecorationType(options) {
  const type = { id: createdTypes.length, options, disposed: false, dispose() { type.disposed = true; } };
  createdTypes.push(type);
  return type;
}

class TextEditor {
  constructor(document, line = 0, character = 0) {
    this.document = document;
    this.selection = new Selection(line, character, line, character);
    this.visibleRanges = [new Range(0, 0, document.lineCount, 0)];
  }
  // Follows `selection` unless a test sets several cursors explicitly.
  get selections() { return this._selections ?? [this.selection]; }
  set selections(v) { this._selections = v; }
  setDecorations(type, ranges) { applied.set(type, ranges); }
}

class TextDocument {
  constructor(text, languageId, uri = 'file:///test') {
    this.languageId = languageId;
    this.version = 1;
    this.uri = makeUri(uri);
    this.fileName = this.uri.fsPath;
    this._setText(text);
  }
  _setText(text) {
    this._text = text;
    this._lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') this._lineStarts.push(i + 1);
  }
  /**
   * Replace [start, end) with `text`, bump the version, and return the
   * onDidChangeTextDocument event VS Code would fire for it.
   */
  applyEdit(start, end, text) {
    const range = new Range(this.positionAt(start), this.positionAt(end));
    this._setText(this._text.slice(0, start) + text + this._text.slice(end));
    this.version++;
    return { document: this, contentChanges: [{ range, rangeOffset: start, rangeLength: end - start, text }] };
  }
  get lineCount() { return this._lineStarts.length; }
  getText() { return this._text; }
  positionAt(offset) {
    let lo = 0;
    let hi = this._lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this._lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return new Position(lo, offset - this._lineStarts[lo]);
  }
  offsetAt(pos) { return this._lineStarts[pos.line] + pos.character; }
  lineAt(line) {
    const start = this._lineStarts[line];
    const end = line + 1 < this._lineStarts.length ? this._lineStarts[line + 1] - 1 : this._text.length;
    return { text: this._text.slice(start, end), range: new Range(line, 0, line, end - start) };
  }
}

/** The stub's event sources, so a test can fire what VS Code would. */
const events = {
  activeEditor: new EventEmitter(),
  colorTheme: new EventEmitter(),
  selection: new EventEmitter(),
  visibleEditors: new EventEmitter(),
  textDocument: new EventEmitter(),
  configuration: new EventEmitter(),
  closeDocument: new EventEmitter(),
  willSave: new EventEmitter(),
  didSave: new EventEmitter(),
  tabs: new EventEmitter(),
  notebook: new EventEmitter(),
};

/** `window.tabGroups`: `all` is what a test sets; `closeTab` fires what VS Code would. */
const tabGroups = { all: [], onDidChangeTabs: events.tabs.event };
const textTab = (doc) => ({ input: { uri: doc.uri }, label: doc.fileName });

const config = new Map();
/** Every `update` call, as `[key, value, target]`, and every status-bar message. */
const configUpdates = [];
const statusMessages = [];
/** command id → the callback registerCommand received. */
const commandHandlers = new Map();
/** command name → canned response, for the semantic-token / symbol providers. */
const lspResponses = {};
/** Every executeCommand call, in order, as `[command, ...args]`. */
const lspCalls = [];
/** Optional `(cmd, ...args) => value | Promise`, consulted before lspResponses. */
let lspHandler;
const vscodeStub = {
  Position, Range, Selection, EventEmitter,
  ThemeColor: class { constructor(id) { this.id = id; } },
  Uri: { parse: (s) => makeUri(s), file: (p) => makeUri(`file://${p}`) },
  // VS Code's values: they are the editor's tracked-range stickiness, which test/transitions-harness.js applies to edits.
  DecorationRangeBehavior: { OpenOpen: 0, ClosedClosed: 1, OpenClosed: 2, ClosedOpen: 3 },
  OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
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
    createStatusBarItem: () => {
      const item = { text: '', tooltip: '', command: '', visible: false, show() { item.visible = true; }, hide() { item.visible = false; }, dispose() {} };
      return item;
    },
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    onDidChangeActiveTextEditor: events.activeEditor.event,
    onDidChangeActiveColorTheme: events.colorTheme.event,
    onDidChangeTextEditorSelection: events.selection.event,
    onDidChangeVisibleTextEditors: events.visibleEditors.event,
    tabGroups,
    showInformationMessage() {},
    setStatusBarMessage: (text) => {
      statusMessages.push(text);
      return { dispose() {} };
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: (key, dflt) => (config.has(key) ? config.get(key) : dflt),
      // As VS Code: the value changes, then onDidChangeConfiguration fires.
      update: async (key, value, target) => {
        configUpdates.push([key, value, target]);
        config.set(key, value);
        events.configuration.fire({ affectsConfiguration: (k) => k.startsWith('okibiDynamic') });
      },
    }),
    onDidChangeTextDocument: events.textDocument.event,
    onDidChangeConfiguration: events.configuration.event,
    onDidCloseTextDocument: events.closeDocument.event,
    onWillSaveTextDocument: events.willSave.event,
    onDidSaveTextDocument: events.didSave.event,
    onDidChangeNotebookDocument: events.notebook.event,
    textDocuments: [],
    notebookDocuments: [],
  },
  commands: {
    registerCommand: (id, fn) => {
      commandHandlers.set(id, fn);
      return { dispose() { commandHandlers.delete(id); } };
    },
    // Serves whatever `setLspResponses` installed. This is what lets a test drive the
    // FULL async cycle — refresh → classify → repaint — instead of only the
    // synchronous render. The blinking bug lived in that cycle, so a stub that always
    // returned undefined could never see it: runClassify bailed and the repaint that
    // followed a real classification never happened.
    executeCommand: async (cmd, ...args) => {
      lspCalls.push([cmd, ...args]);
      return lspHandler ? lspHandler(cmd, ...args) : lspResponses[cmd];
    },
  },
  languages: { registerDocumentSemanticTokensProvider: () => ({ dispose() {} }) },
};

/**
 * Decoded tokens (`{offset, length, type, modifiers}`) → `{ legend, data }`, the
 * legend built from the tokens and the data in the LSP delta wire format.
 */
function encodeTokens(text, toks) {
  const types = [...new Set(toks.map((t) => t.type))];
  const mods = [...new Set(toks.flatMap((t) => t.modifiers))];
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const data = [];
  let pl = 0;
  let pc = 0;
  let l = 0;
  for (const t of [...toks].sort((a, b) => a.offset - b.offset)) {
    while (l + 1 < starts.length && starts[l + 1] <= t.offset) l++;
    const c = t.offset - starts[l];
    data.push(l - pl, l === pl ? c - pc : c, t.length, types.indexOf(t.type),
      t.modifiers.reduce((b, m) => b | (1 << mods.indexOf(m)), 0));
    pl = l;
    pc = c;
  }
  return { legend: { tokenTypes: types, tokenModifiers: mods }, data };
}

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
  install, vscodeStub, createdTypes, applied, events,
  TextDocument, TextEditor, Position, Range, Selection,
  setConfig: (k, v) => config.set(k, v),
  configUpdates,
  statusMessages,
  /** Run a command the way the palette would, through the callback registerCommand received. */
  runCommand: (id, ...args) => commandHandlers.get(id)(...args),
  /**
   * Install canned language-server responses, keyed by command. Tokens go in the
   * LSP delta wire format (see `encodeTokens` for decoded fixtures), because that
   * is what the extension decodes — serving the decoded form would skip
   * `decodeSemanticTokens`, which is exactly the kind of gap that let these bugs
   * through.
   */
  setLspResponses: (map) => Object.assign(lspResponses, map),
  encodeTokens,
  clearLspResponses: () => {
    for (const k of Object.keys(lspResponses)) delete lspResponses[k];
    lspHandler = undefined;
    lspCalls.length = 0;
  },
  /** Answer executeCommand with `fn(cmd, ...args)` instead of the canned map (latency, version-aware tokens). */
  setLspHandler: (fn) => { lspHandler = fn; },
  lspResponses,
  lspCalls,
  /** The onDidChangeTextDocument event for typing `text` at the editor's caret. */
  typing: (editor, text = 'x') => {
    const at = editor.selection.active;
    return { document: editor.document, contentChanges: [{ range: new Range(at, at), rangeOffset: editor.document.offsetAt(at), rangeLength: 0, text }] };
  },
  resetApplied: () => applied.clear(),
  /** A text tab showing `doc`, for `tabGroups.all` and tab events. */
  textTab,
  /** Set the open tabs, one group per argument array. */
  setTabs: (...groups) => { tabGroups.all = groups.map((tabs) => ({ tabs })); },
  /** Remove `tab` from its group and fire onDidChangeTabs with it closed. */
  closeTab: (tab) => {
    for (const g of tabGroups.all) g.tabs = g.tabs.filter((t) => t !== tab);
    events.tabs.fire({ opened: [], closed: [tab], changed: [] });
  },
};
