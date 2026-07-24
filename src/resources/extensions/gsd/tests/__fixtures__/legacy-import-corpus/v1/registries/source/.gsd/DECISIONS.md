# Decisions Register

| # | When | Scope | Decision | Choice | Rationale | Revisable? | Made By |
|---|------|-------|----------|--------|-----------|------------|---------|
| D001 | M001 | storage | Choose persistence | SQLite | Local durable authority | No |
| D002 | M002 | storage | Refine persistence (amends D001) | WAL mode | Safe concurrent reads | Yes | human |
| D003 | M003 | storage | Refine durability (amends D002) | Full sync | Safer checkpoints | Yes | operator |
| D001junk | M004 | parser | Accept loose IDs | Never | Prefix matches are ambiguous | No | agent |

Legacy note: keep the first migration rehearsal for context.
