"""Sample Python file for exercising the Okibi dynamic focus layer.

Move the caret into different blocks and watch the ember bar + fill.
Type to flip Survey 構 -> Focus 流 -> Edit 異 (status bar, bottom-right).

Note: Python has no braces, so focus scopes come from INDENTATION — a line
ending in `:` opens a suite that runs until the next line indented no deeper.
Move the caret between the methods below and the focus should follow each one,
not the whole file.

What to look for:
  Focus 流 — data identities tint (locals, params, `self`, comprehension vars).
    Class names, attribute names, function/method names, and builtins stay band-1.
  Edit 異 — numbers go clay; `await` cyan; writes to out-of-scope names (global)
    get a dashed underline; relaxes to Focus after ~2s.
  Stability — a variable keeps one hue across the function and its comprehensions.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, TypeVar

MAX_RETRIES = 3
DEFAULT_TIMEOUT = 30

# a module global — bold identity when referenced
total_calls = 0

T = TypeVar("T")


class Status(Enum):
    PENDING = 1
    ACTIVE = 2
    CLOSED = 3


@dataclass
class Config:
    """Attribute names are band-1, not data."""

    name: str
    retries: int = MAX_RETRIES
    timeout: int = DEFAULT_TIMEOUT
    tags: dict[str, str] = field(default_factory=dict)

    def with_retries(self, retries: int) -> "Config":
        # `self` is the gold self-slot across the class
        self.retries = retries
        return self


def load_config(name: str) -> Config:
    global total_calls
    cfg = Config(name=name, tags={"env": "dev"})

    if cfg.retries > 0:
        for i in range(cfg.retries):
            # deepest block — cfg + i + backoff are the data identities
            backoff = 1 << i
            print(f"attempt {i} for {cfg.name} (backoff={backoff}ms)")

    total_calls += 1  # escapes the scope — writes the module global
    return cfg


def summarize(cfgs: list[Config]) -> str:
    # comprehension vars (c) keep a stable hue with the surrounding function
    prefix = "cfg"
    parts = [
        f"{prefix}:{c.name} x{c.retries}"
        for c in cfgs
        if c.name
    ]
    return "; ".join(parts)


def fold(cfgs: list[Config], seed: T, reducer: Callable[[T, Config], T]) -> T:
    acc = seed
    for item in cfgs:
        acc = reducer(acc, item)
    return acc


async def fetch_all(names: list[str]) -> list[Config]:
    async def one(name: str) -> Config:
        await asyncio.sleep(0.01)
        return load_config(name)

    jobs = [one(name) for name in names]
    return await asyncio.gather(*jobs)


class Worker:
    """`self` is the gold self-slot; methods are band-1."""

    def __init__(self, worker_id: str) -> None:
        self.id = worker_id
        self.seen = 0
        self.history: list[str] = []

    async def process(self, cfg: Config) -> int:
        self.seen += 1  # write to a self attribute → escapes the block
        results = await fetch_all([cfg.name])
        num_bytes = sum(len(r.name) for r in results)
        if num_bytes > 3:
            self.seen += num_bytes
            self.history.append(cfg.name)
        return num_bytes

    @property
    def score(self) -> float:
        return self.seen / max(1, len(self.history))


def page_through(items: list[Config], size: int):
    for start in range(0, len(items), size):
        yield items[start : start + size]


def main() -> None:
    cfgs = [load_config(name) for name in ("alpha", "beta", "gamma")]
    worker = Worker("w-1")

    total = 0
    for cfg in cfgs:
        total += cfg.retries  # escapes the loop — writes outer `total`

    timeout_sum = fold(cfgs, 0, lambda acc, item: acc + item.timeout)

    for page in page_through(cfgs, 2):
        print(f"page of {len(page)}: {summarize(page)}")

    asyncio.run(worker.process(cfgs[0]))
    print(f"total={total} timeouts={timeout_sum} calls={total_calls}")


if __name__ == "__main__":
    main()
