# Swift

`swift` is a code language: brace blocks, data identities, escape and danger marks,
and the band-1 restores ([Band-1 restores](#band-1-restores)). `Package.swift` and
`.swiftinterface` files open as `swift` too and stay code
([Manifests and interfaces](#manifests-and-interfaces)). The Apple build and data
formats around it are static content ([Static content](#static-content)).
Objective-C and Metal are C-family keys: [c-jvm.md](c-jvm.md#objective-c).

`src/swift.ts` holds the facts the classifier reads (`swiftFacts`), the normaliser
for sourcekit-lsp's tokens (`swiftTokens`) and the band-1 spans (`swiftRestores`);
`src/lex.ts` the `swift` family; `src/focus.ts` reads the function bodies from the
facts; `src/risk.ts` holds `swiftDanger`. Tests: `test/swift.test.js` and the
Swift walks ([runtime.md](runtime.md#transitions)).

| Fixture | Source |
|---|---|
| `test/fixtures/swift/constructs.swift` | synthetic, one of each construct below; it compiles as a loose file too, so its regex literal is `#/…/#`: a bare `/…/` needs Swift 6 mode, which an editor gives a file in a Swift 6 package only, and sourcekit-lsp read it as operators, 4 errors on the line. The bare form's lexing is tested inline (`test/swift.test.js`) |
| `constructs.swift.sk.json` | sourcekit-lsp 6.4 (Command Line Tools, Swift 6.4) over stdio, the file in a SwiftPM package, decoded |
| `Widget.m`, `Widget.h` | synthetic Objective-C |
| `Widget.m.sk.json` | the same server's wire answer for `Widget.m`: the legend it registers and the raw data |
| `test/fixtures/transitions/walk.swift` | synthetic, for the walks; its regex literal `#/…/#` for the same reason |

## Measurements

Up to 40 blocks per file were focused through a real `Decorator` with no server (H)
and with sourcekit-lsp's tokens served (S). The reference is SwiftSyntax 602's
declarations of locals, parameters, closure parameters, captures and file-scope
variables, plus sourcekit-lsp's `variable` reads. A tint is wrong when the reference
has no data token at its offset; a tint outside the function sits in another
function than the focused one. Before is HEAD 93f001c, where Swift shared Scala's
and Dart's `nested` family; after is the port, before the closure-scope change below,
which moved four of these rows over the 98 public files. Every row:
[swift-measurements.csv](swift-measurements.csv).

| Corpus | Measure | Before | After, at the port |
|---|---|---|---|
| 98 public files (swift-argument-parser, swift-collections, swift-nio, Alamofire, Vapor, swift-format, SwiftLint, Ice, CodeEdit, Maccy, Whisky, Inferno, MonitorControl, and the Swift files of AFNetworking, SDWebImage and MetalPetal) and 2 synthetic; 1,842 blocks | wrong tints, H | 10,039 | 1,162 |
| | tints outside the function, H | 6,581 | 32 |
| | tints outside the function, S | 15,015 | 37 |
| | wrong tints, S | 729 | 1,164 |
| | blocks whose tints change when the server answers | 1,506 | 44 |
| | escape marks, S | 552 | 219 |
| the 51 files where sourcekit-lsp types at least 60% of the reference reads; 1,023 blocks | wrong tints, H | 5,773 | 103 |
| | blocks whose tints change when the server answers | 910 | 28 |
| the 100 files, 622,511 non-blank characters | characters in the wrong region against SwiftSyntax's tokens | 5,967 | 3 |
| the 100 files, 62 risks SwiftSyntax finds | danger marks / on a risk / risks missed | 114 / 11 / 51 | 62 / 62 / 0 |

Before, H tinted stored properties (3,621), argument labels (2,922) and names
with no reference (3,453), and S tinted only what the server typed `variable`,
file-wide. Now H and S tint the same names, by design ([Server shape](#server-shape)),
so S's wrong tints are H's. Most of the wrong tints left are reads the reference cannot
see: sourcekit-lsp types nothing in an inactive `#if` region, and swift-nio's
`SelectorUring.swift`, all of it under `#if os(Linux)`, gives 238 of them. The
rest is not broken down.

A closure's scope once started at its line, so a binding before it
(`let names = items.map { $0.name }`) belonged to the closure and never tinted in
its function; the theme's e2e harness found it (2026-11-17). It now starts at the
call the closure trails ([Blocks](#blocks)). Over the 98 public files, 1,814 blocks,
H's right tints went from 7,548 to 7,657 and its missed reference names from 6,756
to 6,672; its wrong tints from 1,162 to 1,193, every new one a read in a file where
sourcekit-lsp types under half of the reference reads, so the reference cannot see
it. S's wrong tints went 1,164 → 1,190, the blocks whose tints change when the server
answers 43 → 41 and the escape marks under S 217 → 215; outside the function stays 32
under H and 37 under S. Over the 49 files it types at least 60% of, right 5,253 →
5,316, missed 4,706 → 4,646, wrong 103, outside the function 28 and changing blocks 27
all unchanged; escape marks under S 159 → 157.

## Lexer

Family `swift`, key `swift`. Scala and Dart stay on `nested`.

| Construct | Lexed as |
|---|---|
| `"…"`, `"""…"""` | string; a `"` string ends at its line |
| `\(…)` | a hole: code up to its unmatched `)`, any depth of nesting |
| `#"…"#`, `##"…"##`, `#"""…"""#` | raw string; the escape and the hole need as many `#`s (`\#(x)`) |
| `/…/` | regex where an expression starts (after `(`, `,`, `=`, an operator, `return`, `case`, `in`, `try`, `await`, `if`, `guard`, `while`, `where`, `else`, `throw`, `switch`, `repeat`, `is`, `as`, `yield`, `let`, `var`), on one line, not opening or closing on a blank and holding no `)` it does not open (SE-0354); else division |
| `#/…/#` | regex, multi-line when the `/` ends its line |
| `#if`, `#available`, `#selector`, `#Preview`, `#warning` | one identifier with its `#`, never a data candidate |
| `` `default` `` | one identifier |
| `'` | punctuation: Swift has no character literal |

The 3 characters left are a nested literal SwiftSyntax itself splits.

## Blocks

`swiftFacts` gives each `{` a kind from its statement's first word, past attributes
(`@MainActor`, `@available(…)`), modifiers and a `label:`:

| Kind | Header | Function scope | Parameters from |
|---|---|---|---|
| type | `struct`, `class`, `enum`, `actor`, `protocol`, `extension` | no | |
| function | `func`, `init`, `deinit`; an accessor (`get`, `set`, `willSet`, `didSet`, `_read`, `_modify`) in an accessor block | yes | the `(` after the keyword; an accessor at its brace |
| accessors | `var x: T {` whose block opens with an accessor; `subscript` the same | no: the accessors are | |
| getter | `var x: T {` otherwise, `subscript(…) -> T {` otherwise | yes | the brace |
| control | `if`, `guard`, `for`, `while`, `switch`, `do`, `catch`, `else`, `repeat`, `defer` | no | |
| closure | a `{` after `(`, `,`, `=`, `:`, `[`, `{`, `?`, `)`, `]`, `>`, `!`, a value word (`return`, `in`, `try`, `await`, `throw`, `yield`, `then`) or a name that is not a keyword (`xs.map {`, `.init {`) | yes | the start of the call it trails, so `xs` in `let names = xs.map { v in` is in the scope and `names` is the enclosing block's; the brace when it trails none (`let f = {`) |

A wrapped header (`public init<T>(\n …\n) where … {`) is read from its first line:
a line ending in `,`, `(`, an operator, or a next line starting with `.`, `,`,
`where`, `->`, `throws`, `async` or `)` continues it.

## Data identities

| Declares data | Scope |
|---|---|
| `let` / `var` in code, tuple patterns too | from the name to the block end |
| `let` / `var` at file scope | the file (bold tier) |
| `guard let x`, `guard case let` | to the enclosing block end |
| `if let x`, `while let x`, `if let x` shorthand | the body |
| `case .a(let x)`, `case let .pair(a, b)`, `case let x as T` | to the next `case` or `default` of that switch |
| `catch let e`; `catch {` | the catch body; `error` implicitly |
| `for x in`, `for (k, v) in`, `for case let x? in`, `for try await x in`, labelled loops | the body |
| `func`, `init`, `subscript` parameters, by internal name: `by step: Int` declares `step` | the body |
| closure parameters `{ a, b in`, `{ (a: T) -> R in`; capture lists `[weak self, x = y]` | the closure |
| `set(v)`; `newValue` in `set` and `willSet`, `oldValue` in `didSet`; `$0`, `$1` | the accessor or the closure; the first use stands in for the declaration |

Never data: a stored property and its implicit-self reads (band 1 paints them
member steel), an argument label `f(label: x)` and a parameter's external name,
keywords and contextual keywords (`inout`, `consuming`, `borrowing`, `some`, `any`,
`each`, `sending`), `copy x` and `consume x` as operators, a member after `.`, a
name after `@` or `\`. Every other identifier binds to the innermost visible
declaration of its name: per name, the declarations sorted by where they start,
found by binary search.

## Server shape

sourcekit-lsp 6.4 from the Command Line Tools, over stdio in a SwiftPM package:

- **No token at any declaration**: not a `let`, a parameter, a closure parameter or
  a pattern binding.
- **Reads `variable`**, parameters included: no `parameter` type is sent.
- **Members `property`**, implicit-self reads included.
- **Operators `method.static.defaultLibrary`** (535) or `operator.defaultLibrary` (106,
  `??` most of them), a user operator `method.static` (8); subscript brackets
  `method.defaultLibrary` (172), a user subscript's `method` (18): 649 and 190 of the
  14,272 tokens over the 98 public files.
- **No keyword or string tokens**; tokens inside `\( )` holes.

`swiftTokens` runs in `buildFileIndex`: it keeps the server's `variable` and
`parameter` reads that resolve to a binding of the facts, adds a `declaration`
token at each declaration site the facts find, and drops a binding the server typed
as something else (a property, a function, a type). So H and S tint the same names
in the same scope, and nothing repaints when the server answers. Without the
normaliser every name read as a global and tinted across the file.

## Escape marks

The facts' declaration sites are the declarations, so `hits += 1` on a local is not
escaping. An `init(…)` is an initializer for the `self` writes
([risk-marks.md](risk-marks.md#escaping-writes)).

## Danger marks

| Marks | Does not mark |
|---|---|
| a force unwrap `x!`, `NSImage.gear!`, `items[0]!`, `f()!` | `!=`, prefix `!flag`, an implicitly unwrapped type: `var v: T!`, `-> T!`, `[T!]`, `[K: V!]`, `(T!, U!)`, `Array<T>!`, `as T!`, and one that ends in a bracket, `@IBOutlet var buttons: [UIButton]!`, `var map: [String: Int]!`, `var completion: (() -> Void)!`, `-> [Item]!`, `let w: (Int, String)!` |
| `try!`, `as!` | `try?`, `as?`, `as`, an `as:` label |
| `unowned(unsafe)`, `nonisolated(unsafe)` | `unowned`, `nonisolated` |
| `@unchecked` (`@unchecked Sendable`) | |

A capitalised name right after `(`, `[` or `,` reads as a type, so `f(Global!)`
is not marked. Before a `]` or `)` the `!` reads past the balanced bracket
(`swiftTypePosition`): a bracket after a name, `)`, `]` or `?` is a subscript or a call,
a value (`items[0]!`, `f()!`); one that holds a capitalised name, `(` or `[` first and
follows a `:` (not a ternary's), `->`, `as`, `is`, `(`, `[` or `,` is a type. The public
corpus holds none of the bracketed forms; UIKit's outlet collections and closure
properties do. `Unsafe*Pointer`, `withUnsafe*` and `unsafeBitCast` are API names, not a switched-off
check, and are not marked: 53 of them in the corpus, mostly swift-nio.

## Band-1 restores

sourcekit-lsp repaints four things off the grammar's register, and no theme key
can single them out by type. `swiftRestores` finds three of them lexically and band 1
paints the grammar's paint back, file-wide, in every phase, with or without a server;
the fourth, a named static call, is read from the server's answer:

| What | Server token | Grammar | Restore |
|---|---|---|---|
| operators that are functions: `==`, `+=`, `??`, `..<`, `&&`, prefix `!flag` and `-x`, a one-sided `i...` | `method.static.defaultLibrary`, which the theme keys operator grey, or `operator.defaultLibrary`; a user operator `static func ==` as `method.static` (a bold call) | `keyword.operator.custom.*`, operator grey | `operatorRestore`, operator grey #9fa5ac / #585e65 |
| a named standard-library static call: `.target(`, `.macOS(`, `JSONSerialization.jsonObject(`, `UnsafeMutablePointer<Int>.allocate(`, `String.init` | `method.static.defaultLibrary`, the type of the operators, so the theme's key paints it operator grey | `support.function.any-method.swift`, a bold call; `init` keyword grey | `callRestore`, bold call blue #6eaff7 / #005eac, over each word token of that type in the server's last answer (`swiftStaticCalls`), only while it has answered |
| subscript brackets `a[i]`, `info?[k]`, `x![0]`, `f()[0]`, `{ … }[0]` | `method.defaultLibrary`, a user subscript's `method`: the editor keeps the bracket-pair colour and takes the bold | not bold; the editor's bracket-pair colour | `bracketRestore`, normal weight and no colour |
| an attribute's `@` and name: `@MainActor`, `@State`, `@Option`, `@escaping` | `class`, `struct`, `enum` (slate) or `macro` (a bold call) over the name | `storage.modifier.attribute.swift`, attribute violet | `attributeRestore`, attribute violet #998cb3 / #705e91 |

Not restored, because the server types none of them or the grammar paints them
otherwise: `=`, `->`, `?` (the ternary and optional sugar), postfix `!` and `?`,
`&x` (an inout argument), `-1` (a literal), a float's exponent sign (`1.5e-3`), `~Copyable`, the `*` of
`@available(*, …)`, anything in a generic clause (`Array<Int>`, `f<T: P>(`), and
the operators of a `#if` / `#elseif` line. Array and dictionary literals, types
(`[String: Int]`), capture lists and `return [a]` are not subscripts.

Over the 98 public files ([swift-measurements.csv](swift-measurements.csv)):

| | Restored | Off the grammar's colour | sourcekit-lsp tokens covered |
|---|---|---|---|
| operators | 1,002 | 0 | 649 of 649 |
| subscript brackets | 328 | none: no colour | 190 of 190 |
| attribute names | 670 | 7 | 69 of 69 |
| named static calls | 151 | 7 | 151 of 151 |

The 7 attribute names are `@ViewBuilder` on a parameter, which the grammar paints
as a parameter name, `@` included; the restore paints the doctrine's violet there.
Of the 686 `method.static.defaultLibrary` tokens sourcekit-lsp sent over the 98
files, 535 are operators and 151 named calls; the grammar paints 144 of those a bold
call and 7, `String.init` passed as a function, `init` keyword grey, which the restore
paints a bold call too. Without the restore every named one turned operator grey once
the server answered (`.target(` and `.macOS(` in every `Package.swift`).
In the editor (the theme's e2e harness, VS Code 1.145.2, 2026-11-17) a subscript's
`[` `]` keep the bracket-pair colour whatever sourcekit-lsp sends, and turn bold
under its `method.defaultLibrary`; an earlier restore at the punctuation floor
painted them off that colour with a server and without.

`self` paints keyword grey as everywhere (`selfWords`). `Self`, `#Preview`-style
freestanding macros, members after `.` and type names are the theme's keys.

## Manifests and interfaces

`Package.swift` manifests hold 2.76 `let`/`var` per 100 lines (27 manifests, 2,751
lines) against 4.21 in sources, and SDK `.swiftinterface` files hold `@inlinable`
bodies (8,176 in `Swift.swiftinterface`, 2,779 indented `let`/`var` lines): both
have data flow, so both stay code. In `_Concurrency.swiftinterface` (Command Line
Tools SDK) the tints over 1,132 blocks fall from 31,683 to 9,486.

## Static content

| Language id | Where it comes from | Before |
|---|---|---|
| `strings` | mhcpnl.xcodestrings 1.0.0 (`.strings`) | default lexer: braces became blocks |
| `project.pbxproj` | mariomatheu.syntax-project-pbxproj 0.1.3 (`.pbxproj`) | the same: 48 blocks in a project file |
| `pbxproj` | EdwinKofler.vscode-assorted-languages 0.32.0 (`.pbxproj`) | the same |
| `xcconfig` | xyqjay.vscode-xcconfig 0.0.1 (`.xcconfig`) | the same |
| `plist` | zhouronghui.propertylist 0.0.2 (`.plist`, by extension, over `xml`'s first line) | the same |
| `swift-gyb`, `tutorial` | swiftlang.swift-vscode 2.18.0 (`.gyb` templates, DocC tutorials) | the same |

The `strings`, `project.pbxproj`, `xcconfig` and `plist` grammars are the
most-installed marketplace extension for their format (20,792, 173,203, 320 and
185,907 installs on 2026-11-17; the `xcconfig` one is not widely installed); each
id's extension and version is in `test/fixtures/static-languages.json`. The
Okibi and Akari theme registers `strings`, `xcconfig` and `metal` itself, with
grammars of its own, and associates `.xcstrings`, `.swift-format` and
`Package.resolved` with `json`. Without the theme and those extensions, `.xcconfig`,
`.pbxproj`, `.strings`, `.xcstrings`, `.metal`, `.swift-format` and
`Package.resolved` open as `plaintext`, XML plists and entitlements as `xml`,
`.swiftlint.yml` as `yaml`: all already non-flow. A binary plist opens as
`plaintext`.

## Cost

Every keystroke is a new version: the relex runs `swiftFacts` and `swiftRestores`
over the whole file. Measured with no server, the caret on a `return` in the middle
of the file: the first classify of a version in Focus, then the median of 15 keys
typed there in Edit, each followed by `runClassify` and `render`. Six runs each, in
ms, median and range (Apple M3 Pro, Node 26.13.0, 2026-11-17); HEAD is 93f001c.

| File | Lines | First classify, HEAD → now | Per keystroke, HEAD → now |
|---|---|---|---|
| swift-format `TokenStreamCreator.swift` | 5,034 | 27.5 (26.3 to 46.1) → 32.6 (31.7 to 33.8) | 11.1 (11.0 to 15.5) → 14.2 (13.4 to 15.8) |
| swift-nio `ByteBufferTest.swift` | 4,730 | 23.2 (22.3 to 24.8) → 39.4 (37.3 to 40.4) | 10.4 (9.8 to 11.5) → 16.4 (15.6 to 18.6) |
| swift-argument-parser `Option.swift` | 1,219 | 8.6 (8.1 to 9.1) → 14.6 (12.1 to 16.0) | 2.0 (1.8 to 3.5) → 3.7 (3.4 to 3.8) |

Of a keystroke on the 5,000-line files, `swiftFacts` takes 5.7 to 7.0 ms (block
kinds about 2, declarations about 3, resolution about 2.3) and `swiftRestores` 1.4
to 1.7. Both are linear in the file (`test/swift.test.js`), a table of closures in
one bracket included (`let routes: [Route] = [` over rows of `Route("r") { req in … },`):
each row's `{` took its header back to the `let` line and scanned it whole for a
depth-0 `=`, 412 ms a lex at 2,000 rows; the scan now carries its answer from one
`{` to the next in a statement, 10 ms.

## Known limits

- **Keystroke cost** is up 3 to 6 ms on 5,000-line files. Not done: keeping block
  kinds by header text across lexes (C and Java's `headerVerdicts`) and resolving
  only the focused block's names.
- **Real editor**: the theme's e2e harness holds the Swift, Objective-C and Metal
  reading in its `swift`, `objc` and `metal` cells (its `e2e/docs/coverage/swift.md`):
  Focus, Edit and every transition scenario under
  sourcekit-lsp, clangd and no server.
- **An empty answer holds band 2**: sourcekit-lsp registers for a `.swiftinterface`
  in the workspace and answers it with no token, so Focus there shows no tint until
  the cold-server schedule runs out, about 30 s ([runtime.md](runtime.md#cold-servers)).
- **Contextual keywords as names**: `set`, `package`, `prefix` and the other
  contextual keywords in `SWIFT_KEYWORDS` are never data, even where they name a
  local or a parameter: 328 `set`, 115 `package` and 61 `prefix` `let`/`var`
  declarations, and 126 `prefix:` parameters, in the 5,348 Swift files of the 18
  cloned repositories.
- **User-defined postfix operators** and operators spelled with Unicode symbols are
  not restored.
- **`Unsafe*` names** are not marked ([Danger marks](#danger-marks)).
- **SDK `.swiftinterface` files** have no SwiftSyntax 602 reference: its parser
  returned no syntax nodes for them, so their numbers above are counts, not errors.

## Regenerating the token fixtures

```bash
node test/gen-swift-semtok.js test/fixtures/swift/constructs.swift > test/fixtures/swift/constructs.swift.sk.json
node test/gen-swift-semtok.js test/fixtures/swift/Widget.m > test/fixtures/swift/Widget.m.sk.json
```

`SOURCEKIT_LSP=/path/to/sourcekit-lsp` picks the server (default: the Command Line
Tools'). A `.swift` file is copied into a scratch SwiftPM package; a `.m` file and
its `.h` get a scratch `compile_commands.json` (`-x objective-c -fobjc-arc`, the
Command Line Tools SDK). Background indexing is off and the answer is taken once it
repeats.
