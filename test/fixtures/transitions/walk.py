import heapq
from os import path as osp

LIMIT = 10


class Loader:
    def __init__(self, retries=3):
        self.retries = retries

    async def load(self, name):
        raw = await fetch(osp.join(name))
        for i in range(self.retries):
            if len(raw) > LIMIT:
                heapq.heappush(raw, i * 2)
        id = len(raw)
        return f"{name!r}: {id:>8} {raw[0]}"


def pick(items, limit):
    return [x for x in items if x < limit]
