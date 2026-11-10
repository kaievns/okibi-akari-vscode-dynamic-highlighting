# Docker, Kubernetes and Go template files

Every id here is static content (`STATIC_CONTENT_LANGUAGES`, `src/focus.ts`): no
blocks, no bands, no band-1 restore, no server request, the phase held in Survey.
Their colours are the theme's alone.

## Ids

The id VS Code 1.144.1 gave each file in the theme repo's e2e harness, 2026-11-10,
with Docker DX 0.18.0, Container Tools 2.5.3, Kubernetes 1.4.1, redhat.vscode-yaml
2.0.0 and helm-ls 1.5.1 loaded:

| File | Id | Registered by |
|---|---|---|
| `Dockerfile`, `Containerfile`, `*.dockerfile`, `Dockerfile.*` | `dockerfile` | `vscode.docker`, Container Tools |
| `compose.yaml`, `docker-compose.yml` | `dockercompose` | `vscode.yaml` |
| `docker-bake.hcl`, `docker-bake.override.hcl` | `dockerbake` | Docker DX |
| `docker-bake.json` | `json` | `vscode.json` |
| manifests, `kustomization.yaml`, `skaffold.yaml`, `Chart.yaml`, `values.yaml` | `yaml` | `vscode.yaml`, redhat.vscode-yaml |
| `templates/**/*.yaml`, `*.yml`, `*.tpl` | `helm` | Kubernetes (`ms-kubernetes-tools.vscode-kubernetes-tools`) |
| `templates/NOTES.txt` | `plaintext` | built in |
| `.helmignore`, `.dockerignore` | `ignore` | Kubernetes, Container Tools |

`*.tmpl` and `*.gotmpl` files are `gotmpl`, which the Go extension (`golang.go`
0.58.0) registers with no grammar and hands to gopls. That id comes from the
extension's `contributes.languages`; no file of it was opened in the harness.

## Servers

What each server sent over stdio, 2026-11-10, for the walk fixtures in
`test/fixtures/transitions/` and the `gotmpl` text in `test/render.test.js`. The
layer asks none of them anything, so none changes what it paints.

| Server | File | Semantic tokens | Document symbols |
|---|---|---|---|
| docker-language-server 0.20.1 (Docker DX) | `walk.docker-bake.hcl` | 38: `property` 10, `string` 8, `operator` 6, `variable` 5, `type` 3, `class` 3, `number` 2, `comment` 1 | 3 |
| docker-language-server 0.20.1 | `walk.Dockerfile` | 0 | none |
| Container Tools 2.5.3's `dockerfile-language-server-nodejs` | `walk.Dockerfile` | 121, 2 of them typed past the end of its legend | |
| yaml-language-server 2.0.0 | `walk.k8s.yaml` | no provider | 8 |
| helm_ls 0.5.4 | `walk.helm.yaml` as a chart's `templates/deployment.yaml` | no provider, and none registered later | 4 |
| gopls 0.23.0 | the `gotmpl` text | 0, from an advertised provider | 18 |

## Real editor

The theme repo's `e2e/` container cells (its `e2e/README.md` § Docker and Kubernetes
coverage) run this tree in VS Code 1.145.2 on 2026-11-10: `dockerfile`, `dockerbake`,
`k8s` (manifests, kustomize, skaffold and chart files as `yaml`), `helm`, `compose`,
`markdown` and `gotmpl`, with their servers answering and without. No file has a focus
item: in each server mode the cell clicks, types, bursts, undoes, deletes a line, deletes
and retypes closers, scrolls, splits, reopens and restarts the server in the file itself,
and every step must show Survey and paint as a fresh editor of the same text does; 586
steps held, and the static scenarios with `host.py` held 364 more (the rerun after the
theme's review fixes, 32 launches). An earlier run showed 異 at one step: an undo in
`docker-bake.hcl` after Cmd+Shift+K. Nothing painted, but an edit then entered
Edit in any document, and an undo that restores the caret where it was reports no caret
event to drop it back (`docs/classification-rules.md`, the engagement table). `onEdit`
now enters Edit only in a document with a scope. gopls sent 10 `macro` tokens for the
cell's 8-line template under the user's settings, which set `ui.semanticTokens`; the
layer asks nothing, and their colour is the theme's.

## Helm

### Before `helm` was listed

`helm` was an unlisted id, so a template got the default lexer and the synthetic
whole-file scope. Over 112 templates (10,956 lines), 109 from `helm create` (Helm
4.3.1) and the bitnami nginx 25.2.14 and redis 28.3.12 charts and 3 synthetic, with
the caret on the most indented line and on the first `$` variable declaration:

| Paint | Count |
|---|---|
| Carets that moved the phase to Focus | 195 of 195 |
| Identity tints | 517, every one on a YAML key or word (`value` 112, `metadata` 56, `mountPath` 55); 0 on a Go template variable |
| Stripe lines | 3,817 |
| Clay numbers | 45 |
| `self` marks | 8: `.Values.self`, and `this` in shell comments inside a block scalar |

Listed, every count is 0 in every file. Per file: `docs/helm-measurements.csv`. The
reference for variables is Go's `text/template/parse` with `SkipFuncCheck`, which
parsed all 112 files. A `gotmpl` file engaged the same way before it was listed;
`test/render.test.js` holds both ids to no paint and the same texts, read as an
unlisted id, to the `self` mark, tints and the stripe.

### Delimiters

The Kubernetes extension's language configuration lists `{{ }}`, `{{- -}}` and
their mixes as bracket pairs and sets no `colorizedBracketPairs`, so bracket-pair
colorization paints every `{{` and `}}` outside a YAML string over the grammar's
`punctuation.definition.mapping.*.helm` scopes; inside a quoted string the grammar
scope shows. The layer paints no restore over them. In VS Code 1.144.1,
`editor.language.colorizedBracketPairs` for `[helm]` set to `( )`, `[ ]` and `{ }`,
as a user setting or as an extension's `configurationDefaults`, leaves `{{ }}` to the
grammar scopes everywhere and keeps the other brackets' colours. Which colour those
scopes take is the theme's.

### Go template variables

`$name := …` and `range $i, $v := …` bind names scoped to the enclosing `if`,
`range`, `with`, `define` or `block` up to its `{{ end }}`. The parse trees of the
112 templates hold 2,062 variables (the `template_vars` column): 457 bound by `:=`
(66 of them in 33 `range $i, $v :=` pairs), 154 reassigned by `=`, 924 uses of a bound name and
527 of the root `$`. 83 files bind a name, and 60 use 202 bound names twice or
more. Focus on them, in `helm` or `gotmpl`, would need a `gotmpl` lexer family
whose actions are code holes in the surrounding text, and a scanner over
`{{ if/range/with/define/block }}` … `{{ end }}`; not done.

## Bake

HCL binds names in `function` parameters, `matrix` keys and `for` expressions.
The public Bake files of buildx and BuildKit (694 lines) hold 1 function with 1
parameter, 2 matrices and no `for` expression; `variable` blocks are file-wide
settings, read as `${NAME}`. Too few bindings for a Focus scope to matter.
