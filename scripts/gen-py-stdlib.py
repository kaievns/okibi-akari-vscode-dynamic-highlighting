# Writes src/pystdlib.ts: the kinds of stdlib names that the import restore's shape
# rule gets wrong or cannot claim (lowercase classes and modules, CapWords names
# that are not classes), resolved from typeshed stubs the way Pylance resolves them.
# usage: python3 -I scripts/gen-py-stdlib.py [typeshed/stdlib dir] > src/pystdlib.ts
# The default is the typeshed bundled with the newest installed Pylance.
# Rules and the Pylance model behind them: docs/import-restore.md.
import ast
import glob
import json
import os
import re
import sys

if len(sys.argv) > 1:
    TS = sys.argv[1]
else:
    def version(path):
        v = re.search(r'pylance-([\d.]+)', path)
        return [int(x) for x in v.group(1).split('.') if x] if v else []
    found = sorted(glob.glob(os.path.expanduser(
        '~/.vscode/extensions/ms-python.vscode-pylance-*/dist/typeshed-fallback/stdlib')), key=version)
    if not found:
        sys.exit('no Pylance typeshed found; pass a typeshed stdlib directory')
    TS = found[-1]

CAPWORDS = re.compile(r'^_*[A-Z][A-Za-z0-9_]*[a-z][A-Za-z0-9_]*$')
SPECIAL_ANN = {'_SpecialForm', 'TypeAlias', '_Final'}
CLASS_CALLS = {'NewType', 'namedtuple', 'NamedTuple', 'TypedDict', 'Enum', 'IntEnum'}
CODE = {'class': 'c', 'module': 'm', 'function': 'f', 'variable': 'v', 'typevar': 't'}


def find_file(mod):
    parts = mod.split('.')
    for c in (os.path.join(TS, *parts) + '.pyi', os.path.join(TS, *parts, '__init__.pyi')):
        if os.path.isfile(c):
            return c
    return None


_trees = {}


def tree(path):
    if path not in _trees:
        try:
            with open(path, encoding='utf8') as f:
                _trees[path] = ast.parse(f.read())
        except (SyntaxError, ValueError):
            _trees[path] = ast.Module(body=[], type_ignores=[])
    return _trees[path]


def flat(body):
    for st in body:
        if isinstance(st, ast.If):
            yield from flat(st.body)
            yield from flat(st.orelse)
        elif isinstance(st, ast.Try):
            yield from flat(st.body)
            for h in st.handlers:
                yield from flat(h.body)
            yield from flat(st.orelse)
        else:
            yield st


def absolute(cur, is_pkg, level, module):
    if level == 0:
        return module
    base = cur.split('.') if is_pkg else cur.split('.')[:-1]
    if level > 1:
        base = base[:len(base) - (level - 1)]
    return '.'.join(base + ([module] if module else []))


def value_kind(v, mod, depth):
    if isinstance(v, ast.Name):
        k = kind_of(mod, v.id, depth + 1)
        if k == 'unknown':
            k = kind_of('builtins', v.id, depth + 1)
        # A variable holding a module is still a variable to Pylance (`os.path`).
        return 'variable' if k == 'module' else k
    if isinstance(v, ast.Attribute) and isinstance(v.value, ast.Name):
        return 'unknown'
    if isinstance(v, ast.Call):
        fn = v.func.id if isinstance(v.func, ast.Name) else v.func.attr if isinstance(v.func, ast.Attribute) else ''
        if fn == '_Alias' or fn in CLASS_CALLS:
            return 'class'
        if fn in ('TypeVar', 'ParamSpec', 'TypeVarTuple'):
            return 'typevar'
        return 'variable'
    if isinstance(v, ast.Subscript):
        return 'class'
    return 'variable'


def kind_of(mod, name, depth=0):
    """Pylance's token kind for `name` imported from `mod`, or 'unknown'."""
    if depth > 12:
        return 'unknown'
    f = find_file(mod)
    if not f:
        return 'unknown'
    is_pkg = f.endswith('__init__.pyi')
    for st in flat(tree(f).body):
        if isinstance(st, ast.ClassDef) and st.name == name:
            return 'class'
        if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef)) and st.name == name:
            return 'function'
        if isinstance(st, ast.Import):
            for a in st.names:
                if (a.asname or a.name.split('.')[0]) == name:
                    return 'module'
        if isinstance(st, ast.ImportFrom):
            for a in st.names:
                src = absolute(mod, is_pkg, st.level, st.module)
                if a.name == '*':
                    if src != mod:
                        k = kind_of(src, name, depth + 1)
                        if k != 'unknown':
                            return k
                    continue
                if (a.asname or a.name) == name:
                    if find_file(src + '.' + a.name):
                        return 'module'
                    return kind_of(src, a.name, depth + 1)
        if isinstance(st, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in st.targets):
            return value_kind(st.value, mod, depth)
        if isinstance(st, ast.AnnAssign) and isinstance(st.target, ast.Name) and st.target.id == name:
            ann = st.annotation
            an = ann.id if isinstance(ann, ast.Name) else ann.attr if isinstance(ann, ast.Attribute) else ''
            if an in SPECIAL_ANN:
                return 'class'
            if isinstance(ann, ast.Subscript) and getattr(ann.value, 'id', getattr(ann.value, 'attr', '')) == 'type':
                return 'class'
            return 'variable'
        if isinstance(st, ast.TypeAlias) and st.name.id == name:
            return 'class'
    if find_file(mod + '.' + name):
        return 'module'
    return 'unknown'


def exported(f):
    names = set()
    for st in flat(tree(f).body):
        if isinstance(st, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            names.add(st.name)
        elif isinstance(st, ast.Assign):
            names |= {t.id for t in st.targets if isinstance(t, ast.Name)}
        elif isinstance(st, ast.AnnAssign) and isinstance(st.target, ast.Name):
            names.add(st.target.id)
        elif isinstance(st, ast.ImportFrom):
            names |= {a.asname for a in st.names if a.asname and a.asname == a.name}
        elif isinstance(st, ast.Import):
            names |= {a.asname for a in st.names if a.asname}
    return {n for n in names if not (n.startswith('_') and not n.startswith('__'))}


mods = []
for root, _, files in os.walk(TS):
    for name in files:
        if name.endswith('.pyi'):
            rel = os.path.relpath(os.path.join(root, name), TS)[:-4].split(os.sep)
            if rel[-1] == '__init__':
                rel = rel[:-1]
            mods.append('.'.join(rel))
mods.sort()

modset = set(mods)
table = {}
for m in mods:
    for n in exported(find_file(m)):
        k = kind_of(m, n)
        cap = bool(CAPWORDS.match(n))
        # A name the package binds wins over its same-named submodule (`os.path`).
        shadows = m + '.' + n in modset and k not in ('module', 'unknown')
        if (not cap and k in ('class', 'module')) or (cap and k not in ('class', 'unknown')) or shadows:
            table.setdefault(m, {})[n] = CODE[k]
for m in mods:
    if '.' in m:
        parent, _, leaf = m.rpartition('.')
        table.setdefault(parent, {}).setdefault(leaf, 'm')

top = sorted({m.split('.')[0] for m in mods})
out = sys.stdout
out.write('// Generated by scripts/gen-py-stdlib.py from the typeshed stubs bundled with Pylance. Do not edit.\n')
out.write('// Only names the shape rule gets wrong. Claimed: c = class, m = module. Refused: t = type variable, f = function, v = variable.\n')
out.write('export const PY_STDLIB_TOP = new Set<string>(%s);\n' % json.dumps(top))
out.write('export const PY_STDLIB: Record<string, Record<string, string>> = {\n')
for m in sorted(table):
    entries = ','.join('%s:%s' % (json.dumps(n), json.dumps(table[m][n])) for n in sorted(table[m]))
    out.write('  %s: {%s},\n' % (json.dumps(m), entries))
out.write('};\n')
