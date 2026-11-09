import os

retries = 3
name = "svc"
total = 0


def connect(host, retries=5, timeout=1.0):
    # retries = 0 would disable the loop
    url = f"{host}:{timeout}"
    return open_conn(url, retries=retries, timeout=timeout)


def open_conn(url, retries, timeout):
    """Open a connection.

    Example:
        retries = 2
        timeout = 9
    """
    attempt = 0
    while attempt < retries:
        attempt += 1
        if attempt == retries:
            timeout = timeout * 2
    return attempt


class Client:
    host: str = "localhost"
    retries: int = 3

    def __init__(self, host, retries):
        self.host = host
        self.retries = retries
        self.name = name

    def bump(self, delta: int = 1):
        global total
        total += delta
        self.retries -= delta
        x: int = 0
        for retries in range(3):
            x += retries
        return x


def walrus(items):
    if (n := len(items)) > 3:
        return n
    return [y for y in items if (z := y) > 0]


def rebind(items):
    acc = []
    for item in items:
        acc = acc + [item]
    return acc


class Registry:
    items = {}

    @classmethod
    def register(cls, key, value):
        cls.items[key] = value

    def __post_init__(self):
        self.ready = True

    def swap(self, other):
        self.a, self.b = other.b, other.a


def outer():
    hits = 0

    def inner():
        nonlocal hits
        hits += 1

    inner()
    return hits


def wrapped(store):
    store["k"] = open_conn(
        "u",
        retries=3,
        timeout=1,
    )
    store["n"] @= 2
