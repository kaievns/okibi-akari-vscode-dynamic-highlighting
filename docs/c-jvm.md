# C, C++, Objective-C, Metal, Java, Kotlin and Groovy

`c`, `cpp`, `cuda-cpp`, `objective-c`, `objective-cpp`, `metal`, `java`, `kotlin`
and `groovy` are code languages: brace blocks, data identities, escape and danger
marks, and the band-1 restores ([Band-1 restores](#band-1-restores)). Objective-C's
methods, selectors and servers: [Objective-C](#objective-c). Swift:
[swift.md](swift.md). CMake, Gradle build scripts in either
DSL, makefiles, devicetree and ZMK keymaps and Maven `pom.xml` are static
content ([Static content](#static-content)). `src/cjvm.ts` holds the facts the
classifier reads, `src/lex.ts` the lexer keys, `src/focus.ts` the function
headers and Kotlin's expression bodies, `src/risk.ts` the casts. Tests:
`test/cjvm.test.js`, the Groovy rows of `test/lexer.test.js`, and the C / JVM
transition walks ([runtime.md](runtime.md#transitions)).

The token fixtures in `test/fixtures/cjvm` are synthetic sources with each
server's answer captured over them:

| Fixture | Server |
|---|---|
| `constructs.c.cpptools.json` | ms-vscode.cpptools 1.35.6 in VS Code 1.145.2, through the theme's e2e harness |
| `constructs.cpp.clangd.json` | clangd 22.1.8 (Homebrew `llvm@22`) over stdio, `-std=c++20` |
| `Constructs.java.jdtls.json` | jdtls 1.63.0 from redhat.java 1.58.0 over stdio, no project |
| `constructs.kt.kls.json`, `ctor.kt.kls.json` | kotlin-language-server 1.3.13 (Homebrew) over stdio, `JAVA_HOME` the Homebrew `openjdk@21` |

## Measurements

Per corpus, up to 40 blocks per file were focused through a real `Decorator`
twice: with no server (H) and with the reference server's tokens (S). A tint is
wrong when the reference has no `variable` or `parameter` token at its offset;
an H miss is a tint S has and H lacks. Every row:
[c-jvm-measurements.csv](c-jvm-measurements.csv). Before is HEAD 588ed19.

| Corpus | Server | H wrong | H missed | S tints | Blocks repainting on load |
|---|---|---|---|---|---|
| C: zlib, curl/sqlite3/pthread/stdio headers, 2 synthetic (32 files) | clangd 22.1.8 | 3,628 → 2,777 | 970 → 363 | 18,362 → 18,241 | 206 → 181 of 488 |
| the same, cpptools shape (clangd without `declaration`) | | 3,639 → 2,777 | 46,688 → 354 | 63,467 → 18,237 | 347 → 180 of 488 |
| the same, 29 files | cpptools 1.35.6 | 3,295 → 2,414 | 46,588 → 350 | 63,818 → 18,589 | 342 → 146 of 446 |
| C++: fmt, libc++, LLVM ADT, 2 synthetic (21 files) | clangd 22.1.8 | 20,857 → 1,401 | 1,455 → 511 | 8,238 → 3,843 | 369 → 230 of 551 |
| the same, 17 files | cpptools 1.35.6 | 21,824 → 2,312 | 14,601 → 594 | 17,327 → 2,819 | 436 → 248 of 513 |
| Java: OpenJDK `java.base`, `jdk.internal`, 2 synthetic (18 files) | jdtls 1.63.0 | 4,995 → 469 | 606 → 75 | 5,259 → 5,167 | 285 → 97 of 525 |
| Kotlin: kotlinpoet, stdlib, 3 Gradle scripts, 2 synthetic (49 files) | kls 1.3.13, normalised | 10,744 → 1,234 | 4,931 → 693 | 10,542 → 6,974 | 658 of 830 → 244 of 920 |

Escape marks on a declaration, cpptools shape: C 104 → 10, C++ 329 → 10. The
Kotlin sample has 920 blocks after, not 830: expression bodies are blocks now.
Each corpus's 2 synthetic files are this repo's `samples/` file of the language
(`sample.c`, `sample.cpp`, `Sample.java`, `sample.kt`) and the matching
`constructs.c`, `constructs.cpp`, `Constructs.java` or `Constructs.kt` in the
theme's `scripts/fixtures/c-jvm/server/`.
cpptools answered nothing, or a few tokens, for 3 C files (`stdio.h`, zlib's
`crc32.h` and `inffixed.h`) and 4 C++ files (fmt's `base.h`, `std.h` and
`format.cc`, libc++ `vector`) of the capture; those are left out.

## Lexer

| Key | Language ids | Differs from the rest of its family |
|---|---|---|
| `c` | `c` | no receiver keyword |
| `objc` | `objective-c` | `self` is the receiver |
| `cpp` | `cpp`, `cuda-cpp` | `R"d(…)d"` raw strings, C++ keywords, templates, `this` |
| `objcpp` | `objective-cpp` | as `cpp`, and `self` too |
| `metal` | `metal` | as `cpp`; the address spaces and function qualifiers (`device`, `constant`, `thread`, `threadgroup`, `kernel`, `vertex`, `fragment`, `visible`, `stitchable`) and `half`, `uint`, `ushort`, `uchar` are keywords |
| `java` | `java` | |
| `groovy` | `groovy` | Groovy strings, below |
| `kotlin` | `kotlin` | |

Groovy is the `java` family with its own strings ([lexer.md](lexer.md)):
`'…'` and `'''…'''` have no holes; `"…"` and `"""…"""` are GStrings with `$a`,
`$a.b.c` and `${…}` holes; a `/` in expression position opens a slashy string
(`\/` is a slash) and `$/` a dollar-slashy one (`$$` and `$/` escape), both
multi-line with holes; `#!` on the first line is a comment. Before, Groovy fell
to the default lexer: `'''` and slashy strings read as code.

## Blocks

| Header | Before | Now |
|---|---|---|
| C++ `T get() const {`, `void f() noexcept {`, `auto f(int x) -> int {`, `) override {`, `) & {`; Java `) throws IOException {` | not a function: its parameters belonged to no scope | a function (`QUALIFIED_SIGNATURE`) |
| the same tail on a line of its own: `) const noexcept {` under a wrapped parameter list | not a function | the header runs back to the `(` (`SIGNATURE_TAIL`) |
| Kotlin `fun f(x: Int): Int = x * 2`, `fun main() = runBlocking {…}` | no block: the parameters belonged to no scope | a function scope from `(` to the end of the expression (`scanKotlinExprBodies`) |
| Kotlin `public class B(private val w: Int) {`, `data class`, `enum class` | a function: the header ends in `)` | a type (`KOTLIN_TYPE_DECLARATION`) |

Function scopes on the corpora: C++ 1,037 → 1,820, Java 700 → 753, Kotlin 688
→ 1,195 (1,195 includes the expression bodies). An expression body ends at a
line break at depth 0, unless the line ends in an operator or the next line
opens with `.`, `?.`, `?:`, `&&`, `||`, an arithmetic operator, `as`, `is`,
`in`, `else`, `catch` or `finally`; or at a `;`, or at the bracket that closes
what holds the function.

`memberTest` (`src/cjvm.ts`) tells a type body from code: the innermost `{`
block holding an offset, and whether its header opens a type. The header reaches
back to the last `;`, `{` or `}`, so it can carry `#include` lines, export
macros, a `package` line or an earlier Kotlin declaration; the last type keyword
outside brackets decides. After it a C or C++ header holds no `(`
(`struct node *alloc(int n) {` is a function) and a Java header none but a
record's components; a Kotlin header holds no `fun`, `val`, `var`, `get`, `set`,
`init` or `=` at depth 0. `template <class T>`'s `class` sits inside `<…>` and
does not count. `new X(…) {` is an anonymous class.

## Data identities

| Language | Not data | Data |
|---|---|---|
| C, C++, Objective-C | `#` directive lines and their `\` continuations (macro bodies, conditions); `typedef` declarators; declarations in a struct, union, enum or class body; C++ template parameter lists | locals, parameters, file-scope variables |
| C++ | `typename`, `concept`, `requires` and the other C++ keywords | every name of a structured binding (`auto [a, b] = p`, `const auto& [k, v] : m`), and a declarator after `auto&`, `auto&&` or `auto*`, a range-for's too (`for (const auto& x : xs)`): `auto` is a keyword, so the declarator rule passes it by |
| Java | fields, at every depth of a class, interface, enum, record or anonymous class body; `transient`, `permits`, `sealed` and the other Java keywords | lambda parameters `w ->`, `(a, b) ->`, `(String s) ->`; `instanceof T x`, `case T x ->`, record patterns `Point(int x, var y)` |
| Kotlin | `val` / `var` at top level or in a type body (kls types them `property`); constructor `val` / `var` parameters | locals, parameters, lambda parameters, plain constructor parameters (`class A(x: Int)`), expression-body parameters, a `for (x in xs)` variable and each name of `for ((k, v) in m)` |
| Groovy | fields; `def f(…)` names a method | `def x = …`, `var x`, typed locals, closure parameters `{ a, b -> }`, `{ String s -> }`, a `for (x in xs)` variable |

A name right after `->` is a read in Java, Groovy and Kotlin, where the arrow
opens a lambda, a closure or a `case` / `when` arm (`w -> out.merge(w)`,
`filter(n -> n > LIMIT)`); in C and C++ it stays a member (`p->x`) or a
trailing return type. Before, the C rule held in every language: in the theme's
e2e `java` cell without a server (2026-11-14) the `lambdas` item left `out`
untinted in `w -> out.merge(…)` and tinted it on the lines around. On the
corpora below, with no server, Java's misses went from 114 to 75 and Kotlin's from
736 to 693; wrong tints rose by 7 (462 to 469) and 14 (1,220 to 1,234).

Each of C, C++, Java, Kotlin and Groovy has its own keyword list in place of
the cross-language one. That list held JavaScript, Python and Rust words:
`function`, `from`, `match`, `in`, `str`, `type` and `val` were never data in
these languages, though they are ordinary names there (Java `function` 270,
`match` 166, `from` 117; C `in` 322).

A plain Kotlin constructor parameter is skipped when the class body declares a
`val` or `var` of the same name (`class C(names: List<String>) { private val
names = names.toList() }`): past its initializer the name is the property.

## Server shapes

| Server | Shape | What the classifier does |
|---|---|---|
| cpptools 1.35.6 | its legend has no `declaration` modifier; every initializer read as a write, and locals traced across functions | when no token carries `declaration`, the heuristic's declaration sites stand in |
| cpptools 1.35.6 | one token request waits per file (its `SemanticTokensProvider.allFileData`): a request while another waits rejects the waiting one with `Canceled`, so the editor's own request for a new version and the classifier's cancel each other. A version's answer comes once IntelliSense has run (`C_Cpp.intelliSenseUpdateDelay`, 1 s), and a request after that gets it at once | a `Canceled` rejection is superseded, not an answer: the fetch stays in flight and asks again after 1.5 s, 3 s and 6 s while the document version holds (`cancelRetrySchedule`), so band 2 neither holds nor starts the 1-15 s cold retries on it. Still cancelled after 10.5 s, the answer reads as `empty` ([runtime.md](runtime.md#cold-servers)); any other failure is no answer. Before, the first `Canceled` read as `empty`. This rule alone did not make the theme's e2e `c` cell hold under cpptools (2026-11-14: the `main` Focus item untinted, 10 steps of 6 scenarios differing, while clangd and no server held every step); the batches below were the cause, found with `okibiDynamic.debug` |
| cpptools 1.35.6 | IntelliSense hands a version's tokens over in batches (`handleIntelliSenseResult`, `deliverTokens`): the first resolves the request waiting for that version, a later one extends the answer and fires `onDidChangeSemanticTokens`, which only the editor hears. So a request can get part of the file's tokens, or none while no editor shows the file (a reopen): in the e2e `c` cell 5 of 65 classifies with cpptools tokens found no data name in a block that has some, and a run that logged every answer for `constructs.cpp` got 0 tokens at open and 80, 83, 163 and 171 of 259 after edits, and the next request, 0.2 to 1.2 s later, all 259 | a C-family answer with tokens is provisional until a second answer for the same version carries the same data (`lastAnswer`, `dataKey`): it is asked again after 250 ms, 500 ms, 500 ms, 1 s, 1 s and 2 s (`confirmSchedule`) and stops at the first that matches; an answer that differs starts the waits again, at most 12 requests a version. cpptools answers a version it has answered at once, so the extra request cancels nothing. With it the `c` cell's 10 Focus and Edit captures and every transition step held but one, the `split` step cpptools' own dimming misses (theme `e2e/docs/coverage/c-cpp-java-kotlin.md`). The `cpp` cell still differed in 18 steps of 11 scenarios (2026-11-14), each against a fresh render that had caught an empty or partial answer after a reopen; since an answer that changes for the same version starts the waits again, its 10 captures and 17 scenarios held (2026-11-15) |
| clangd 22.1.8 | `parameter` on prototypes and function-pointer members (`int (*xRead)(sqlite3_file*, void*, int iAmt)`) | a parameter outside every function and not in a lambda's list is dropped (`signatureParameter`), as a type signature's ([classification-rules.md](classification-rules.md#type-declarations-are-not-data)) |
| jdtls 1.63.0 | a field read bare between commas, `g(a, size, b)`, is `property` | not read as a `{ name }` shorthand: C, Java, Kotlin and Zig have none (`NO_SHORTHAND_FAMILIES`) |
| kls 1.3.13 | `"$amount"` adds a `variable` over `$amount` beside the one over `amount`; a local `val` is `property.declaration`, its reads `variable`; a constructor `val` is `parameter` | the `$` token is dropped; a local's `property.declaration` becomes `variable` (`kotlinLocal`); a constructor `val` / `var` becomes `property`. The editor still paints the `$amount` token the page colour, so band 1 repaints it ([Band-1 restores](#band-1-restores)) |
| kls 1.3.13 | an abstract or interface method's parameters, a function type's (`f: (value: Int) -> Int`) | dropped (`signatureParameter`); a constructor's stay |
| jdtls 1.63.0, kls 1.3.13 | a token sent after one that follows it: jdtls a record pattern's type after its bindings (`instanceof Point(int x, int y) && x > y`), kls an extension's receiver after the function's name (`fun String.shout(times: Int)`) and an annotation after the `val` it annotates, a line above. The deltas fall below zero and reach the extension wrapped in a `Uint32Array`. VS Code 1.145.2 reads them signed and drops only a token that overlaps the one before it on its line (`Point`, behind `y`); a decoder that reads them unsigned puts every later token of the line, or after a line delta every later token of the file, past the text. The companion's did: in the theme's e2e `java` cell (2026-11-14) the `describe` Focus item tinted `x` and `y` at their bindings and the format call but not in the condition | `decodeSemanticTokens` reads both deltas as signed 32-bit and sorts the tokens when one went back. The captured jdtls and kls streams, served in their own order, decode to every token at its offset (`test/cjvm.test.js`) |

cpptools is what the user's editor runs: the theme's e2e harness profile runs it
with `C_Cpp.default.compilerPath=/usr/bin/clang`, and clangd only for
comparison. jdtls answers alike in standard and syntax mode. kls 1.3.13 starts
only with a JDK: in the user's editor Kotlin has no server until
`kotlin.java.home` points at one (`openjdk@21` is keg-only, `/usr/bin/java` is
the macOS stub).

## Receivers

`selfWords(syntax)` (`src/lex.ts`) names the receiver keywords band 1 paints and
the escape rule treats as the object root.

| Key | Receivers |
|---|---|
| `c` | none: `self` and `this` are ordinary names (`struct obj *self`) |
| `objc` | `self` |
| `cpp` | `this` |
| `objcpp` | `this`, `self` |
| `java`, `groovy`, `kotlin` | `this` |

Before, every C-family, Java and Kotlin file painted both `self` and `this`
keyword grey: 15 `self` names in the C++ and Java corpora.

## Danger marks

Zig's precedent ([zig.md](zig.md#danger-marks)): a cast that reinterprets
memory or drops a qualifier marks, a cast that converts a value does not.

| Language | Marks | Does not mark |
|---|---|---|
| `c` | `(T *)x`, `(const T *)x`: a C cast to a pointer type | `(int)d`, `(void)x`, `(size_t)n`: value casts |
| `objective-c` | C's pointer casts; `(__bridge T)x`, `(__bridge_transfer T *)x`, `(__bridge_retained T)x`, which hand an object across the ARC boundary unchecked; `performSelector:` and its `OnMainThread:` and `InBackground:` forms, a selector the compiler cannot check | a method signature's types, `- (NSString *)name:(id)x`, and an `@property (…)` list; `@selector(performSelector:)` and a method declared `- (void)performSelector:(SEL)s`, which send nothing |
| `cpp`, `cuda-cpp`, `metal` | `reinterpret_cast<…>`, `const_cast<…>`, C casts to a pointer or reference type; in an Objective-C header, `objective-c`'s inside an interface | `static_cast`, `dynamic_cast`, `std::bit_cast`, value casts; in an Objective-C header, a signature's types |
| `objective-cpp` | `cpp`'s and `objective-c`'s | the same |
| `java` | `(Ref) x`: a reference cast, checked at run time like Kotlin's `as`; `@SuppressWarnings("unchecked")`, `"rawtypes"` | `(int) d`: primitive casts |
| `kotlin` | `as`, `as?`; `x!!`; `@Suppress("UNCHECKED_CAST")` | `import … as` |
| `groovy` | none | |

| Corpus | Marks | Functions with a mark |
|---|---|---|
| C | 170, all pointer casts | 53 of 205 (26%) |
| C++ | 49: 24 `reinterpret_cast`, 15 `const_cast`, 10 C casts | 35 of 1,820 (1.9%) |
| Java | 114: 74 casts, 40 `@SuppressWarnings` | 61 of 753 (8.1%) |
| Kotlin | 94 (was 52): 52 `as`, 24 `@Suppress`, 18 `!!` | 67 of 1,195 (5.6%) |

zlib is cast-heavy: `(z_const char *)` 47 times, `(struct inflate_state FAR *)`
23. Danger marks paint in the Edit phase only, in the focused block.

## Band-1 restores

- `this` / `self`: per [Receivers](#receivers).
- `NULL`, `true`, `false` and `bool`, in every C-family id, and in `objective-c` and
  `objective-cpp` also `nil`, `Nil`, `YES`, `NO`, `TRUE`, `FALSE` (builtin red) and
  the ARC and nullability qualifiers `__weak`, `__strong`, `__block`,
  `__unsafe_unretained`, `__autoreleasing`, `__nullable`, `__nonnull` and
  `__null_unspecified` (keyword grey), which the Objective-C grammar paints as
  constants and `storage.modifier.arc.objc`: cpptools and clangd send
  `macro` over each use, with no modifier that tells them from `MAX(a, b)`, and the
  theme paints `macro` a bold call. 88 of cpptools' 5,367 macro tokens in the
  theme's public C and C++ corpus are these four (theme `docs/c-jvm.md` § C and C++, The
  macro decision). `cMacroRestores` (`src/cjvm.ts`) finds them lexically and band 1
  paints `NULL`, `true` and `false` builtin red (`constantRestore`) and `bool`
  keyword grey (the `self` type), file-wide and in every phase, with or without a
  server: the paint is the grammar's, so with no server nothing changes. The name a
  `#define` or `#undef` defines and a `defined(…)` operand keep the grammar's bold
  call. Other object-like macros (`BUF_LEN`, `EXIT_SUCCESS`) keep the server's bold
  call: no lexical rule tells a constant macro from a function-like one used bare.
  Over 40 files of AFNetworking, SDWebImage, FMDB and MetalPetal, clangd 22.1.8
  sends 739 `macro` tokens over these names; 103 were restored before, 739 now, and
  none of the 1,000 restored names is painted otherwise by the grammar
  ([swift-measurements.csv](swift-measurements.csv)). `NS_ENUM`, `NS_OPTIONS`,
  `NS_DESIGNATED_INITIALIZER`, `NS_UNAVAILABLE` and `API_AVAILABLE` are a bold
  call in the grammar and under clangd alike, so nothing is restored;
  `NS_ASSUME_NONNULL_BEGIN` and `_END` are the page colour in the grammar and a bold
  call under clangd, which is the theme's to settle.
- Kotlin `$name` templates: kls sends `variable` over `$name`, 227 tokens in the
  theme's corpus, which the theme paints the page colour; the grammar paints the
  whole `$name` member steel. `kotlinTemplateSpans` reads the lexer's `$name` holes
  and band 1 paints `$` and name member steel (`placeholder`), with or without the
  server. A `${…}` hole's delimiters are the grammar's; kls sends nothing over them.
  In Focus a data name's tint lays over the name, as on every placeholder.
- Other format placeholders (`%d`, `String.format`, `std::format`): none. No server
  types string literals: the cpptools, clangd, jdtls and kls legends carry no
  `string` token over a literal, so TextMate's placeholder scopes stand.
- Imports and shadows: none. Java and Kotlin imports are grammar-typed.

## Objective-C

`.m` opens as `objective-c`, `.mm` as `objective-cpp`, and a `.h` as `cpp`
(step 7 of the theme), so a header shared with Objective-C is read with the C++
rules outside its `@interface`, `@protocol` and `@implementation` … `@end` regions
and with the Objective-C facts inside them (`objcHeaderRegions` in `src/cjvm.ts`): a
signature's types are no casts, and selector parts, `@property` names and macros
are not data. A region a half-typed file leaves open runs to the end. Over 426
public headers (23 of the Command Line Tools SDK's, and AFNetworking's,
SDWebImage's, FMDB's and MetalPetal's), the danger marks on method and `@property`
lines went 2,301 in 214 files → 0; a cast in an inline function outside the
regions still marks.

| Construct | Before | Now |
|---|---|---|
| `- (instancetype)initWithName:(NSString *)name count:(NSInteger)count {` | not a function: its parameters tinted across the file | a function scope from the `-` or `+` (`OBJC_METHOD` in `src/focus.ts`); the whole signature is its parameter list |
| a method's parameters, `name` and `count` above | read as globals | declared: a name after a type's `)` in a signature (`objcFacts` in `src/cjvm.ts`) |
| selector parts: `initWithName:` in a signature, `insertObject:` and `atIndex:` in `[o insertObject:x atIndex:i]`, the unary `copy` in `[name copy]` | tinted as data (1,137 wrong tints in the corpus below) | never data candidates |
| `(NSString *)` in a signature, `@property (nonatomic, copy)` | danger: a pointer cast | not marked ([Danger marks](#danger-marks)) |

27 files of AFNetworking, SDWebImage, FMDB and MetalPetal that clangd 22.1.8
typed, 635 blocks, against clangd's `variable` and `parameter` tokens
([swift-measurements.csv](swift-measurements.csv)): wrong tints with no server
1,656 → 433, danger marks 169 → 73, blocks whose no-server tints differ from
clangd-served ones 391 → 321.

### Servers

| Server | Serves | Notes |
|---|---|---|
| cpptools 1.35.6 | `c`, `cpp`, `cuda-cpp` | no Objective-C: its activation events and document selectors name none, and none of its scripts mentions `objective-c`. It does serve a `.h` as `cpp` and parses an Objective-C header as C++: for the theme's e2e `Store.h` it sends 2 tokens (79 over 12 public headers, the theme `docs/swift.md` § Swift and its ecosystem), and since that sparse answer is all the layer reads, the inline function's locals take no tint (the theme's `e2e/docs/coverage/swift.md`) |
| clangd (vscode-clangd) | `objective-c`, `objective-cpp` too | the reference above |
| sourcekit-lsp (swiftlang.swift-vscode 2.18.0) | `c`, `cpp`, `objective-c`, `objective-cpp` | the extension activates once the workspace holds a `Package.swift`, `compile_commands.json`, `compile_flags.txt`, `buildServer.json` or `.bsp/*.json`, or a Swift file opens; for a folder without a `Package.swift` it starts no server (its log: `found 0 packages`; the theme's e2e harness). The answers below were captured over stdio (`test/gen-swift-semtok.js`) |

sourcekit-lsp 6.4 registers clangd's legend for those four ids (`variable`,
`variable`, `parameter`, `function`, …) but encodes the data in its own Swift legend
(`namespace`, `type`, `class`, …). Over `Widget.m`, its 253 tokens match the
Command Line Tools' clangd 21.0.0 on all 253 types read with its own legend, and on
25 read with the one it registers; none of 42 Objective-C and Objective-C++ files
fit the registered legend (type index 26, modifier bit 20). The editor reads every
token under the wrong type (`NSString` a parameter, a local a class); before, the
companion read the answer as `empty` and band 2 waited for the cold retries.
`sourcekitClangLegend` (`src/classify-lsp.ts`) spots the shape (clangd's legend
with a `parameter` carrying `defaultLibrary`, which clangd never sends and
sourcekit-lsp's `class` with it is) and decodes with `SOURCEKIT_LEGEND`. On the
corpus, served as sourcekit-lsp sends it: wrong tints 1,656 → 100, blocks
differing from clangd-served ones 391 → 25. The editor's paint needs an upstream fix
in swiftlang/sourcekit-lsp, or a setting: the theme `docs/swift.md`'s (§ Swift and its ecosystem,
**The Objective-C legend**) turns semantic highlighting off for `objective-c` and
`objective-cpp` and keeps sourcekit-lsp's diagnostics;
`swift.sourcekit-lsp.supported-languages: ["swift"]` hands Objective-C to clangd or to
nothing.

### Metal

`.metal` opens as `metal`, the id and grammar the Okibi and Akari theme registers
(doublebuffer.metal-shader 1.0.5, the most-installed Metal grammar on 2026-11-17
with 16,569 installs, declares the same id); without either it opens as `plaintext`.
Before, the id fell to the default lexer. Key `metal` reads it as
C++ with Metal's keywords ([Lexer](#lexer)), `this` as the receiver, and C++'s casts
and danger marks. Over 16 public shaders with clangd 22.1.8 over a C++ shim, 460 of
596 no-server tints match clangd's, as with the default lexer; the 136 left are
SwiftUI shader parameters clangd could not type without SwiftUI's Metal header.
Opening `.metal` as `cpp` instead is the theme's call: either id reads the same.
The C restores apply: the theme's grammar, the C++ one with Metal's words, paints
`true`, `false` and `bool` as they restore, and doublebuffer's leaves `NULL` the page
colour, which the restore paints red (no shader in the 16 uses it).

## Static content

| Language id or file | Why |
|---|---|
| `cmake` (`CMakeLists.txt`, `*.cmake`) | configuration: commands and `${VAR}`s, no data flow. Before, Focus engaged and the symbol provider was asked |
| `gradle`: `groovy` and a `.gradle` name | no declaration in 527 lines of 22 Gradle documentation snippets, against 4.68 per 100 lines in 129 public `.groovy` files (groovy-swing, groovy-console, groovy-templates, Jenkins pipeline examples); band 1 restores it as `groovy`, so `this` keeps its paint |
| `gradle-kts`: `kotlin` and a `.gradle.kts` name | no declaration in 528 lines of the 22 matching snippets, against 7.63 per 100 lines in 44 `.kt` files (kotlinpoet, stdlib); band 1 restores it as `kotlin` |
| `gradle-kotlin-dsl` | the id redhat.java gives a `.gradle.kts` file, which VS Code picks over fwcd.kotlin's `kotlin` when both are installed (the theme's e2e `gradlekts` cell, 2026-11-14); the same build scripts, so static too. Before, it fell to the default lexer and Focus engaged. Band 1 restores nothing in it |
| `makefile`, `dts` (`.dts`, `.dtsi`, `.overlay`, ZMK `.keymap`), `xml` (`pom.xml`) | unchanged: already static |

`Jenkinsfile` opens as `groovy` and stays code. Markdown fences of any of these
languages are prose.

## Cost

Every keystroke is a new version: the relex rebuilds the type-body test and the
Focus or Edit classify runs again. Measured with no server, the caret on a `return`
in the middle of the file: the first classify of a version in Focus, then the median
of 15 keys typed there in Edit, each followed by `runClassify` and `render`. Three
runs each, interleaved, in ms (Apple M3 Pro, Node 26.13.0, 2026-11-15); HEAD is
588ed19, and "before" is this change before the type-body test was made lazy.

| File | Lines | First classify, HEAD → now | Per keystroke, HEAD → before → now |
|---|---|---|---|
| Kotlin stdlib `_Arrays.kt` | 25,599 | 57 to 64 → 70 to 72 | 35.3 to 35.7 → 72.3 to 73.7 → 38.9 to 39.7 |
| kotlinx.coroutines `BufferedChannel.kt` | 3,115 | 30 to 34 → 35 to 37 | 15.2 to 15.4 → 23.3 to 25.2 → 18.4 to 19.1 |
| kotlinpoet `CodeWriter.kt` | 864 | 16 to 22 → 20 | 5.0 to 5.2 → 7.0 → 6.2 to 6.3 |
| googletest `gtest.h` | 12,399 | 28 → 37 to 46 | 12.9 to 13.4 → 23.1 to 25.2 → 14.0 to 15.1 |
| LLVM `STLExtras.h` | 2,688 | 14 to 16 → 19 to 21 | 4.9 to 5.3 → 8.4 to 8.5 → 5.8 to 6.2 |
| JDK `MethodHandles.java` | 8,260 | 18 to 19 → 22 to 23 | 6.7 to 7.0 → 12.2 to 12.5 → 8.4 to 8.7 |
| zlib `deflate.c` | 2,139 | 14 to 15 → 16 to 21 | 4.1 to 4.5 → 5.3 to 5.6 → 4.6 to 5.0 |
| groovy-console `Console.groovy` | 1,896 | 16 to 18 → 15 | 5.0 to 5.1 → 5.9 to 6.0 → 4.5 to 4.6 |

Before, `memberTest` read the header of every `{` block in the file on each lex,
character by character with a span lookup for each, and ran `isTypeHeader` on it:
in `_Arrays.kt` that was 39 of the 73 ms. Now a header is read only for a block an
offset is asked about, walking `punct` and `spans`, and its verdict is kept by
header text across lexes (`headerVerdicts`, cleared at 20,000 entries), so a
keystroke reads the headers its edit changed: 2 ms of the 39. The two walks read
the same text: 34,525 of 34,525 `{` headers in the C, C++, Java, Kotlin and
Groovy corpora above. What remains over HEAD is the rest of this change's
classification: Kotlin's expression bodies and constructor parameters, C's
declarators and directives.

With a server's tokens the first classify cost 3.9 → 6.7 ms (`sqlite3.h`, 14,447
lines, cpptools), 6.9 → 8.4 (`STLExtras.h`, clangd) and 7.2 → 10.0 (`CodeWriter.kt`,
kls), measured before the type-body test was made lazy. On cpptools tokens the
heuristic's declaration sites are computed too; they are cached per lex, so the
no-server path reuses them.

## Known limits

- Inside `#if`, `#ifdef` and `#ifndef` conditionals the heuristic tints names
  clangd sends no token for, its inactive branches: 2,437 of C's 2,777 wrong
  tints and 1,242 of C++'s 1,401. The lexer cannot evaluate a condition.
- A local that shares a function's name in the file is no candidate on the
  heuristic path (Kotlin `val internalIndex = internalIndex(index)`, `val builder
  = Builder(…)` beside `fun builder()`): 139 and 118 of the 693 Kotlin misses.
- clangd sends no token for some reads in a dependent template context
  (`loc.get<…>()` in fmt's `chrono.h`); those blocks repaint.
- jdtls, run without a project, sends no token for 366 of the names the
  heuristic tints, 252 of them in `ClassRemapperImpl.java` and 55 in
  `Collectors.java`; those blocks repaint when it answers.
- Kotlin's implicit `it` is no data identity on the heuristic path: kls types 14
  of its 118 uses in the corpus, 13 as `variable` or `parameter`.
- A Kotlin `val` in a top-level lambda (`val x = run { val y = 1 }`) is local on
  both paths only because it sits in a block; kls types it `property`.
- A wrapped C++ trailing return of an elaborated type (`auto f() -> struct x {`)
  reads as a struct body.
- Writes to Kotlin top-level properties carry no escape mark: the property is no
  data identity.
- On the heuristic path a Groovy closure assigned with `=` whose body starts on its
  arrow's line (`def add = { a, b -> a + b }`) loses its first parameter: `b` is data and
  `a` is not. One whose arrow ends the line, and a closure passed to a call
  (`xs.each { a, b -> … }`), keep both. The cause is not traced.

## Regenerating the token fixtures

clangd, jdtls and kls run over stdio with an LSP client that opens the file,
waits for diagnostics and asks `textDocument/semanticTokens/full`; cpptools runs
only inside VS Code, so its fixture comes from the theme's e2e harness dump. The
client is not in this repo. Offsets in a fixture are UTF-16 offsets into its
source as committed: an edit to the source needs a new capture.
