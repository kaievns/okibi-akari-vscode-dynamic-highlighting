from collections import defaultdict


class Fill:
    """A single fill on the tape."""

    id: int
    qty: int = 0


class Book:
    """
    Keeps the live window of trades.
    """

    def __init__(self, size: int):
        self.size = size
        self.seen = defaultdict(int)

    def push(self, id: int, time: int) -> None:
        if id in self.seen or id <= 0:
            return
        self.seen[id] += 1

    def trim(self, up_to: int) -> int:
        dropped = 0
        for id in range(up_to):
            dropped += id * 2
        return dropped


def main() -> None:
    book = Book(size=10)
    book.push(id=1, time=2)
    print(f"total {book.trim(up_to=5)}")
