import sys
import heapq
from collections import deque, defaultdict

class Tape:
    W: int
    queues: dict[str, deque[tuple[int, int, int]]] # ticker
    vwapsies: dict[str, tuple[int, int]]
    max_heap: list[int]

    def __init__(self, size:int):
        self.W = size
        self.queues = defaultdict(deque)
        self.vwapsies = defaultdict(lambda: (0, 0))
        heapq.heapify(self.min_heap)
        x = sys.argv[1]
        q: deque = deque()
        t = tuple(x)
        isinstance(x, deque)
