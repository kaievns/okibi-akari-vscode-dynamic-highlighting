#!/usr/bin/env python3
# The shell lexer's reference: every variable occurrence and compound command
# shfmt's parser sees in one file, at UTF-16 offsets, as test/shell.test.js reads it:
#   python3 -I test/gen-sh-ref.py bash test/fixtures/shell/constructs.sh > test/fixtures/shell/constructs.sh.ref.json
#   python3 -I test/gen-sh-ref.py bash test/fixtures/transitions/walk.sh > test/fixtures/shell/walk.sh.ref.json
# Needs shfmt on PATH (brew install shfmt; 3.14.1 measured).
import json, subprocess, sys, re
SPECIAL = set('0123456789@*#?-$!')
IDENT = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')
def facts(path, dialect):
    raw = open(path, 'rb').read()
    try:
        out = subprocess.run(['shfmt', '--to-json', '-ln', dialect], input=raw, capture_output=True, timeout=20)
    except Exception as e:
        return {'error': str(e)}
    if out.returncode != 0:
        return {'error': out.stderr.decode('utf8', 'replace')[:200]}
    tree = json.loads(out.stdout)
    # byte offset -> char offset
    text = raw.decode('utf8', 'replace')
    b2c = {}
    bi = 0
    for ci, ch in enumerate(text):
        b2c[bi] = ci
        bi += len(ch.encode('utf8'))
    b2c[bi] = len(text)
    C = lambda b: b2c.get(b['Offset'] if isinstance(b, dict) else b, None)
    vars_, blocks, funcs, strings, comments, commands = [], [], [], [], [], []
    def off(p):
        return p['Offset'] if isinstance(p, dict) else p
    def add(name_node, kind):
        v = name_node.get('Value', '')
        if not v or v[0] in SPECIAL or not IDENT.match(v):
            return
        s = C(name_node['Pos'])
        vars_.append([s, len(v), v, kind])
    def arith_names(n):
        if isinstance(n, dict):
            if n.get('Type') == 'Lit' and IDENT.match(n.get('Value', '')):
                add(n, 'arith')
            elif n.get('Type') == 'ParamExp':
                walk(n)
                return
            for k, x in n.items():
                if k not in ('Pos', 'End'):
                    arith_names(x)
        elif isinstance(n, list):
            for x in n:
                arith_names(x)
    def lit_text(w):
        parts = (w or {}).get('Parts') or []
        return ''.join(p.get('Value', '') for p in parts if p.get('Type') == 'Lit') if parts and all(p.get('Type') == 'Lit' for p in parts) else None
    def walk(n, ctx=None):
        if isinstance(n, list):
            for x in n:
                walk(x, ctx)
            return
        if not isinstance(n, dict):
            return
        t = n.get('Type')
        if 'Comments' in n:
            for c in n['Comments'] or []:
                comments.append([C(off(c['Hash'])), C(off(c['End'])) if 'End' in c else None])
        if t == 'ParamExp':
            p = n.get('Param')
            if p:
                add(p, 'read')
            for k in ('Index', 'Slice', 'Repl', 'Exp'):
                if n.get(k):
                    if k == 'Index' and (p or {}).get('Value') in assoc:
                        walk(n[k])
                    elif k == 'Index':
                        arith_names(n[k])
                    else:
                        walk(n[k])
            return
        if t in ('ArithmCmd', 'ArithmExp'):
            arith_names(n.get('X'))
            return
        if t == 'FuncDecl':
            funcs.append([C(n['Pos']), C(n['End']), (n.get('Name') or {}).get('Value') or ''])
        if t in ('FuncDecl', 'IfClause', 'WhileClause', 'ForClause', 'CaseClause', 'Block', 'Subshell'):
            blocks.append([C(n['Pos']), C(n['End']), t])
        if t in ('SglQuoted', 'DblQuoted'):
            strings.append([C(n['Pos']), C(n['End']), t])
        if t == 'WordIter' or t == 'CStyleLoop':
            if n.get('Name'):
                add(n['Name'], 'loop')
        if t == 'CStyleLoop':
            for k in ('Init', 'Cond', 'Post'):
                arith_names(n.get(k))
            return
        if t in ('CallExpr', 'DeclClause'):
            for a in (n.get('Assigns') or []) + ([x for x in (n.get('Args') or []) if isinstance(x, dict) and 'Name' in x and isinstance(x['Name'], dict) and 'Naked' not in x] if t == 'DeclClause' else []):
                if isinstance(a, dict) and isinstance(a.get('Name'), dict) and not ('Value' in a or 'Append' in a or 'Index' in a or 'Array' in a):
                    add(a['Name'], 'assign')
        if t == 'CallExpr':
            args = n.get('Args') or []
            if args:
                first = lit_text(args[0])
                if first is not None:
                    commands.append([C(args[0]['Pos']), len(first), first])
                if first == 'printf':
                    for i, a in enumerate(args[1:-1], 1):
                        if lit_text(a) == '-v':
                            s2 = lit_text(args[i + 1])
                            if s2 and IDENT.match(s2):
                                vars_.append([C(args[i + 1]['Pos']), len(s2), s2, 'cmdarg'])
                if first in ('read', 'unset', 'mapfile', 'readarray', 'export', 'getopts'):
                    skip_next = False
                    for i, a in enumerate(args[1:], 1):
                        s = lit_text(a)
                        if skip_next:
                            skip_next = False
                            continue
                        if s is None:
                            continue
                        if s.startswith('-'):
                            takes = 'dinNptu' if first == 'read' else 'dnOsuCc'
                            skip_next = first in ('read', 'mapfile', 'readarray') and s[-1:] in takes and len(s) == 2
                            continue
                        if first == 'getopts' and i == 1:
                            continue
                        if IDENT.match(s):
                            vars_.append([C(a['Pos']), len(s), s, 'cmdarg'])
        if t is None and 'Name' in n and isinstance(n['Name'], dict) and 'Value' in n['Name'] and ('Value' in n or 'Naked' in n or 'Append' in n or 'Index' in n or 'Array' in n):
            add(n['Name'], 'assign')
            if n.get('Index'):
                arith_names(n['Index'])
            for k in ('Value', 'Array'):
                if n.get(k):
                    walk(n[k])
            return
        if t == 'Heredoc' or (t is None and n.get('Hdoc')):
            pass
        for k, x in n.items():
            if k in ('Pos', 'End', 'Position'):
                continue
            if k == 'Hdoc' and x:
                strings.append([C(x['Pos']), C(x['End']), 'heredoc'])
            walk(x, ctx)
    # A subscript of an array declared associative (`declare -A`) is a key, not arithmetic.
    assoc = set()
    def find_assoc(n):
        if isinstance(n, list):
            for x in n:
                find_assoc(x)
        elif isinstance(n, dict):
            if n.get('Type') == 'DeclClause' and any(lit_text(a.get('Value')) and lit_text(a['Value']).startswith('-') and 'A' in lit_text(a['Value']) for a in (n.get('Args') or []) if isinstance(a, dict) and a.get('Naked') and a.get('Value')):
                for a in n.get('Args') or []:
                    if isinstance(a, dict) and isinstance(a.get('Name'), dict):
                        assoc.add(a['Name'].get('Value'))
            for k, x in n.items():
                if k not in ('Pos', 'End'):
                    find_assoc(x)
    find_assoc(tree)
    walk(tree)
    return {'vars': vars_, 'blocks': blocks, 'funcs': funcs, 'strings': strings, 'comments': comments, 'commands': commands}

if __name__ == '__main__':
    dialect, path = sys.argv[1], sys.argv[2]
    r = facts(path, dialect)
    if 'error' in r:
        sys.exit(r['error'])
    text = open(path, encoding='utf8').read()
    # shfmt's offsets are code points; the editor's are UTF-16 units.
    u16 = [0]
    for ch in text:
        u16.append(u16[-1] + (2 if ord(ch) > 0xffff else 1))
    ver = subprocess.run(['shfmt', '--version'], capture_output=True, text=True).stdout.strip()
    vars_ = sorted({(u16[v[0]], v[1], v[2]) for v in r['vars']})
    blocks = sorted({(u16[b[0]], u16[b[1]], b[2]) for b in r['blocks']})
    rows = lambda xs: ',\n'.join('  ' + json.dumps(list(x)) for x in xs)
    print('{\n "shfmt": %s,\n "dialect": %s,\n "vars": [\n%s\n ],\n "blocks": [\n%s\n ]\n}' % (json.dumps(ver), json.dumps(dialect), rows(vars_), rows(blocks)))
