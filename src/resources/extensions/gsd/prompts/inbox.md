You are running the GSD **inbox** workflow — triage and review open GitHub issues and PRs against the project's conventions, using the GitHub Issues tracker referenced in AGENTS.md.

## Flags

- `--issues` / `--prs` — {{focusFlag}} (which to review; default both)
- `--label <name>` — {{labelFlag}}
- `--close-incomplete` — {{closeIncompleteFlag}} (close items that don't meet contribution requirements)
- `--repo <owner/repo>` — {{repo}}

## Process

1. **Fetch open items.** Use the `gh` CLI (or the project's GitHub integration) to list open issues and/or PRs, applying the label and repo filters.

2. **Triage each item** against the project's contribution guide and templates:
   - **Issues**: is it actionable? Does it have reproduction, labels, expected/actual? Route: promote to backlog (`/gsd backlog add`), request info, or close incomplete.
   - **PRs**: does it meet the PR checklist (tests, docs, conventional commits, scope)? Route: request changes, request review, or merge-ready.

3. **Present the triage** with the recommended action per item. When `--close-incomplete` is ON, also act on the clear-close items (with a comment explaining why).

4. **Act on confirmation** for non-close actions: add to backlog, request changes, etc. Never merge or close-without-comment automatically.

## Success criteria

- Triage is grounded in the actual issue/PR content, not assumptions.
- Each item gets a concrete recommended action.
- Destructive actions (close, merge) require confirmation or an explicit flag.
- Actionable issues feed the backlog so they aren't lost.
