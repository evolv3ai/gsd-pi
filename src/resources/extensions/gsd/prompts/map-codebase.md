You are running the GSD **map-codebase** workflow — analyze the codebase and produce structured reference documents that planning and execution can rely on. Output goes to `.gsd/codebase/`.

## Scope

{{scope}}

## Output directory

`{{outputDir}}`

## Philosophy

- **Practical detail over arbitrary brevity.** Include enough to be useful as reference, with real code patterns.
- **Always include file paths** formatted with backticks (e.g. `src/services/user.ts`). These documents are reference material for planning and execution.
- Prefer reading the code directly over guessing.

## Documents to produce

Write a well-structured Markdown file in `{{outputDir}}/` for each relevant document:

- **STACK.md** — languages, runtimes, versions; key frameworks/libraries; build tools; package manager.
- **INTEGRATIONS.md** — third-party APIs/services; databases; auth providers; infra/deploy; comms services.
- **ARCHITECTURE.md** — architecture style; core data flow; key design patterns; module/package boundaries.
- **STRUCTURE.md** — directory layout with purpose of each top-level dir; entry points; where tests live.
- **CONVENTIONS.md** — coding conventions, naming, error handling, logging patterns.
- **TESTING.md** — test framework(s), how to run tests, test structure, coverage approach.
- **CONCERNS.md** — technical debt, risk areas, TODO/FIXME clusters, fragile areas.

Only produce documents relevant to this project (skip ones with nothing to say). Stamp each document's YAML frontmatter with `last_mapped_commit: <current HEAD sha>` so drift can be detected later.

## Process

1. Detect the project's stack and structure (read manifests, top-level dirs, entry points).
2. Read representative source files to ground each document in real evidence.
3. Write each document with concrete examples and file paths.
4. Print a short summary of which documents were created/updated and their line counts.

## Success criteria

- Every produced document is grounded in real code with file paths.
- Documents live under `.gsd/codebase/`.
- Each document has a `last_mapped_commit` frontmatter stamp.
