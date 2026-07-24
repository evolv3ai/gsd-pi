# Project Knowledge

## Rules

| # | Scope | Rule | Why | Added |
|---|-------|------|-----|-------|
| K001 | authority | Use database authority. | Prevent projection drift. | M001 |

## Patterns

| # | Pattern | Where | Notes |
|---|---------|-------|-------|
| P001 | Derived views are replaceable | projections | Rebuild only outside import. |

## Lessons Learned

| # | What Happened | Root Cause | Fix | Scope |
|---|--------------|------------|-----|-------|
| L001 | A snapshot drifted | It was treated as truth | Preserve source evidence | import |
