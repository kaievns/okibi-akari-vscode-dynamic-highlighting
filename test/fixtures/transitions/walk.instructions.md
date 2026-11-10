---
applyTo: "**/*.py"
---

# Python style

- Prefer ==early returns== over nested branches; this keeps self-checks flat.
- Type every public function. See [PEP 484](https://peps.python.org/pep-0484/).

```python
class Pool:
    def take(self, n: int = 2) -> dict[str, object]:
        if n > self.size:
            raise ValueError(f"want {n}, have {self.size}")
        return {"taken": [self.items.pop() for _ in range(n)], "left": {"size": self.size}}
```

<!-- ==not a mark== inside a comment -->
