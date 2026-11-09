LIMIT = 10


def report(total, items):
    for item in items:
        msg = f"{total=} {item=}"
        print(f"{LIMIT=}", f"{total = }", f"{item=!r:>10}")
        log(msg)
    return total


def load(raw, parse):
    try:
        value = parse(raw)
    except ValueError:
        value = None
    return value


def choose(flag, items):
    if flag:
        result = len(items)
    elif items:
        result = 1
    else:
        result = 0
    return result


def one_line(flag):
    if flag: out = 1
    else: out = 2
    return out


def dispatch(cmd):
    match cmd:
        case "go":
            action = 1
        case _:
            action = 0
    return action


def accumulate(xs):
    total = 0
    for x in xs:
        total = total + x
    count = 0
    if xs:
        count += 1
    return total, count
