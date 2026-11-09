def swap(xs):
    a, b = 1, 2
    for _ in xs:
        a, b = b, a
    return a, b
