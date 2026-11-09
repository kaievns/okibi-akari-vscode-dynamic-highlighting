"""Pylance-shaped semantic tokens from the stdlib ast (Pylance itself cannot run outside VS Code).
Legend follows Pylance's package.json: parameter.keywordArgument for kwarg names,
selfParameter for self, property for attributes, variable/parameter for data.
Usage: python3 -I test/gen-py-semtok.py FILE [1|0] > FILE.tokens.json
  1: every store carries `declaration` (the likely Pylance shape, not verified); 0: only the first per scope.
"""
import ast, json, sys, builtins

path = sys.argv[1]
store_is_decl = (sys.argv[2] if len(sys.argv) > 2 else '1') == '1'
src = open(path).read()
lines = src.split('\n')
starts = [0]
for l in lines:
    starts.append(starts[-1] + len(l) + 1)

def off(lineno, col):
    # ast col offsets are utf-8 byte offsets; corpus is ASCII
    return starts[lineno - 1] + col

toks = []
def emit(name, o, typ, mods):
    toks.append({"name": name, "offset": o, "length": len(name), "type": typ, "modifiers": mods})

BUILTINS = set(dir(builtins))

class V(ast.NodeVisitor):
    def __init__(self):
        self.params = [set()]
        self.funcs = set()
        self.classes = set()
        self.modules = set()
        self.declared = [set()]
    def visit_Import(self, n):
        for a in n.names:
            self.modules.add((a.asname or a.name).split('.')[0])
    visit_ImportFrom = visit_Import
    def _fn(self, n):
        self.funcs.add(n.name)
        # name token after 'def '
        line = lines[n.lineno - 1]
        c = line.find('def ' + n.name)
        if c >= 0:
            emit(n.name, off(n.lineno, c + 4), 'function', ['declaration'])
        for d in n.decorator_list:
            self.visit(d)
        args = n.args
        allargs = args.posonlyargs + args.args + args.kwonlyargs + ([args.vararg] if args.vararg else []) + ([args.kwarg] if args.kwarg else [])
        for d in args.defaults + args.kw_defaults:
            if d is not None:
                self.visit(d)
        ps = set()
        for a in allargs:
            ps.add(a.arg)
            typ = 'selfParameter' if a.arg in ('self', 'cls') else 'parameter'
            emit(a.arg, off(a.lineno, a.col_offset), typ, ['declaration'])
            if a.annotation is not None:
                self.visit(a.annotation)
        if n.returns is not None:
            self.visit(n.returns)
        self.params.append(ps)
        self.declared.append(set())
        for s in n.body:
            self.visit(s)
        self.params.pop()
        self.declared.pop()
    visit_FunctionDef = _fn
    visit_AsyncFunctionDef = _fn
    def visit_Lambda(self, n):
        ps = set()
        for a in n.args.args:
            ps.add(a.arg)
            emit(a.arg, off(a.lineno, a.col_offset), 'parameter', ['declaration'])
        self.params.append(ps)
        self.visit(n.body)
        self.params.pop()
    def visit_ClassDef(self, n):
        self.classes.add(n.name)
        line = lines[n.lineno - 1]
        c = line.find('class ' + n.name)
        if c >= 0:
            emit(n.name, off(n.lineno, c + 6), 'class', ['declaration'])
        for b in n.bases:
            self.visit(b)
        for d in n.decorator_list:
            self.visit(d)
        self.declared.append(set())
        for s in n.body:
            self.visit(s)
        self.declared.pop()
    def visit_keyword(self, n):
        if n.arg is not None:
            # Pylance: parameter.keywordArgument
            line = lines[n.lineno - 1]
            emit(n.arg, off(n.lineno, n.col_offset), 'parameter', ['keywordArgument'])
        self.visit(n.value)
    def visit_Attribute(self, n):
        self.visit(n.value)
        # attr name position: end_col - len(attr)
        o = off(n.end_lineno, n.end_col_offset - len(n.attr))
        emit(n.attr, o, 'property', [])
    def visit_Name(self, n):
        name = n.id
        o = off(n.lineno, n.col_offset)
        if name in ('self', 'cls'):
            emit(name, o, 'selfParameter', [])
            return
        if any(name in p for p in self.params):
            emit(name, o, 'parameter', [])
            return
        if name in self.funcs:
            emit(name, o, 'function', [])
            return
        if name in self.classes:
            emit(name, o, 'class', [])
            return
        if name in self.modules:
            emit(name, o, 'module', [])
            return
        if name in BUILTINS and not isinstance(n.ctx, ast.Store):
            emit(name, o, 'function' if callable(getattr(builtins, name)) else 'variable', ['builtin'])
            return
        mods = []
        if isinstance(n.ctx, ast.Store):
            if store_is_decl or name not in self.declared[-1]:
                mods = ['declaration']
            self.declared[-1].add(name)
        emit(name, o, 'variable', mods)

V().visit(ast.parse(src))
toks.sort(key=lambda t: t['offset'])
print(json.dumps(toks))
