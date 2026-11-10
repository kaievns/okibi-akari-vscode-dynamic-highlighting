---
description: Review the staged change for data races
mode: agent
tools: ['codebase', 'search']
---

# Review for races

Read the ==staged== diff and list every shared value that two tasks touch.
Follow [the checklist](https://example.com/review/checklist) and this note: https://example.com/notes.

```ts
import { lock } from './lock';

async function drain(self: Queue, limit = 8) {
  for (let i = 0; i < limit; i++) {
    const job = await self.next();
    if (job) { console.log(`job ${job.id} of ${limit}`); }
  }
}
```

Report each race with the line that reads it and the line that writes it.
