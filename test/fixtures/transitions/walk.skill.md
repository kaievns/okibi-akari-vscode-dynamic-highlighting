---
name: release-notes
description: Drafts release notes from merged pull requests
---

# Release notes

1. List the merged pull requests since the last tag.
2. Group them by ==user-facing change==, not by author.
3. Link each entry: [#123](https://example.com/pull/123).

```bash
notes() {
  local this="${1:-HEAD}" count=0
  git log --merges --format='%s' "$(git describe --tags --abbrev=0)..${this}" | while read -r line; do
    { echo "- ${line}"; count=$((count + 1)); }
  done
}
```

[guide]: https://example.com/release-guide
