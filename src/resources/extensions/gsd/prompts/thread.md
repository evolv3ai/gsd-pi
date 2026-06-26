You are running the GSD **thread** workflow — manage persistent context threads for cross-session work, backed by the memory store so threads survive across sessions.

## Action

{{action}}

## Process

A thread is a named, resumable context line: a topic, the open question, decisions so far, and the next step. Threads live in the gsd-pi memory store so they persist and are queryable.

Parse the action:

- **list [--open|--resolved]** (default): list threads filtered by state. Each entry: slug, status, last-updated, one-line topic.
- **close <slug>**: mark a thread resolved (record the resolution as a knowledge lesson if durable).
- **status <slug>**: show a thread's full context (topic, decisions, open question, next step).
- **<name> / <description>** (bare text): create or update a thread with the given name/description, stamping the current state and next step.

Use `/gsd memory` as the backing store for thread persistence. When closing a thread whose resolution is a reusable lesson, also record it via `/gsd knowledge lesson`.

## Success criteria

- Threads persist in the memory store, not in a throwaway file.
- Listing honors the open/resolved filter.
- Resolved threads with durable lessons feed the knowledge store.
