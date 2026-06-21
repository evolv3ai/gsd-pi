You are running the GSD **code-review** workflow — review source files changed during recent work for bugs, security issues, and code quality problems.

## Scope

{{scope}}

## Depth

{{depth}}

## Fix mode

{{fixMode}}

## Process

1. **Determine the file set.** Use the explicit `--files` list if provided. Otherwise derive the changed source files from the active slice's recent commits / SUMMARY, or fall back to the git diff against the base branch. Exclude `.gsd/`, lockfiles, generated/vendored code, and docs unless `--files` names them.

2. **Review each file** at the requested depth:
   - **quick** — bugs, security, and correctness only.
   - **standard** (default) — quick + maintainability, error handling, edge cases.
   - **deep** — standard + performance, concurrency, API design, test coverage gaps.

   Ground every finding in the actual code with file path + line reference. Categorize each by severity (critical / warning / nit) and type (bug, security, quality, performance).

3. **Write the review.** Produce `.gsd/reviews/{{reviewId}}-REVIEW.md` with the findings table and per-finding detail (location, issue, suggested fix).

4. **Present results.** Summarize counts by severity and list the critical findings first.

5. **Fix mode** (only when `--fix` is set): for each finding that is safely auto-fixable (deterministic, no behavior change beyond the fix), apply it. After each fix batch, run the project's tests. Commit atomically with the finding IDs referenced in the message. Do not auto-apply findings that are ambiguous or that change public behavior — surface those for a human decision instead.

## Success criteria

- Every finding cites a concrete file path and line.
- Findings are categorized by severity and type.
- The review is written to `.gsd/reviews/`.
- Fixes only touch safely-auto-fixable findings, and tests run after each batch.
