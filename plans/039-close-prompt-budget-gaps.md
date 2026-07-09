# Plan 039: Close the three prompt-budget enforcement gaps (execute-task, discuss-slice, provider ratio)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 43033bb9..HEAD -- src/resources/extensions/gsd/auto-prompts.ts src/resources/extensions/gsd/guided-flow.ts src/resources/extensions/gsd/context-budget.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW–MED
- **Depends on**: none (touches `auto-prompts.ts` — coordinate if plan 036/037 executors are active, different files expected)
- **Category**: perf (LLM token usage)
- **Planned at**: commit `43033bb9`, 2026-07-08

## Why this matters

The context-budget engine right-sizes inlined prompt content to the executor's
context window — but three gaps mean it isn't applied where it matters most:

1. `buildExecuteTaskPrompt` — the **most frequently dispatched** prompt in
   auto mode — is the only major builder that skips the `capPreamble` budget
   cap: 12 sibling call sites cap their inlined context; execute-task inlines
   the full task plan, slice excerpt, knowledge, and templates uncapped. On
   small-window executors (32K local models — the case
   `context_window_override` exists for) the prompt can silently exceed the
   window.
2. `buildDiscussSlicePrompt` (guided flow) hand-rolls the same inlining with
   no cap at all and its content **grows with every completed slice** (full
   ROADMAP + CONTEXT + RESEARCH + entire DECISIONS register + every completed
   slice's full SUMMARY): a milestone with ~8 done slices inlines ≈60KB
   (~15K tokens) per discuss-slice dispatch.
3. `computeBudgets(contextWindow, provider?)` supports a provider-aware
   chars/token ratio (3.5 for Anthropic/Bedrock vs the 4.0 default), but no
   production call site passes the provider — Anthropic budgets are computed
   ~14% too large, over-packing prompts toward the overflow side.

## Current state

Files and their roles:

- `src/resources/extensions/gsd/auto-prompts.ts` — prompt factory.
  `capPreamble` at lines 239–247; `resolvePromptBudgets` at ~89–100;
  the second `computeBudgets` call at ~404–412; `buildExecuteTaskPrompt`
  ~2629–2892 (no capPreamble inside — verify with the grep below).
- `src/resources/extensions/gsd/guided-flow.ts` — `buildDiscussSlicePrompt`
  at ~1202–1288, uncapped inlining.
- `src/resources/extensions/gsd/context-budget.ts` — `computeBudgets`
  signature `computeBudgets(contextWindow: number, provider?: TokenProvider)`
  (~line 124); exports `truncateAtSectionBoundary`;
  `resolveExecutorContextWindow(...)` accepts a provider arg at the second
  auto-prompts call site.
- `src/resources/extensions/gsd/token-counter.ts` — `getCharsPerToken`
  (anthropic/claude-code/bedrock = 3.5, openai/google = 4.0).

Excerpt — `auto-prompts.ts:89-100` (call site 1 — no provider):

```ts
function resolvePromptBudgets(): ReturnType<typeof computeBudgets> {
  try {
    const prefs = loadEffectiveGSDPreferences();
    const sessionWindow = prefs?.preferences.context_window_override;
    const windowTokens = resolveExecutorContextWindow(undefined, prefs?.preferences, sessionWindow);
    return computeBudgets(windowTokens);
  } catch (e) {
    logWarning("prompt", `resolvePromptBudgets failed: ${(e as Error).message}`);
    return computeBudgets(200_000);
  }
}
```

Excerpt — `auto-prompts.ts:~404-412` (call site 2 — provider available but
not passed to computeBudgets):

```ts
    windowTokens = resolveExecutorContextWindow(undefined, undefined, sessionContextWindow, sessionProvider);
  }
  const budgets = computeBudgets(windowTokens);
```

Excerpt — `auto-prompts.ts:239-247` (the cap every sibling uses):

```ts
function capPreamble(preamble: string): string {
  // Cap inlined context at min(static ceiling, scaled inline budget).
  const budget = Math.min(MAX_PREAMBLE_CHARS, resolvePromptBudgets().inlineContextBudgetChars);
  if (preamble.length <= budget) return preamble;
  return truncateAtSectionBoundary(preamble, budget).content;
}
```

capPreamble call sites at planning time (12): lines 1676, 1699, 1962, 2118,
2271, 2462, 3028, 3215, 3494, 3586, 3698, 3833 — note the gap between 2462
and 3028 spanning `buildExecuteTaskPrompt`.

Excerpt — `guided-flow.ts:~1265-1268` (uncapped join):

```ts
  const inlinedContext = inlined.length > 0
    ? `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`
    : `## Inlined Context\n\n_(no context files found yet — go in blind and ask broad questions)_`;
```

Also relevant: `MAX_PREAMBLE_CHARS = 20_000` (`auto-prompts.ts:77`);
`computeBudgets`' tiktoken probe uses `"the quick brown fox…"` — a known
over-estimator for code content (ECON-02, recorded as unplanned follow-up;
do NOT redesign the probe in this plan).

Conventions: single quotes in `auto-prompts.ts`/`guided-flow.ts` are mixed
with double — match surrounding lines. Tests:
`src/resources/extensions/gsd/tests/context-budget.test.ts` (35 tests,
verified green at planning time) and `auto-prompts-fallback.test.ts` are the
patterns.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck extensions | `pnpm run typecheck:extensions` | exit 0 |
| Budget tests | `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/context-budget.test.ts` | 35+ pass |
| Prompt tests | `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/auto-prompts-fallback.test.ts` | all pass |
| Changed-file tests | `node scripts/verify-changed-src-tests.mjs` | pass |

## Scope

**In scope** (the only files you should modify):

- `src/resources/extensions/gsd/auto-prompts.ts`
- `src/resources/extensions/gsd/guided-flow.ts`
- `src/resources/extensions/gsd/context-budget.ts` (export additions only)
- Test files under `src/resources/extensions/gsd/tests/`

**Out of scope** (do NOT touch, even though they look related):

- The budget ratio constants (SUMMARY_RATIO/INLINE_CONTEXT_RATIO/…) and the
  tiktoken probe string — separate finding (ECON-02).
- Carry-forward windowing and template re-inlining (DISPATCH-04/05) — bigger
  behavioral changes, unplanned this round.
- A whole-prompt final size gate (DISPATCH-02) — desirable but needs a
  section-priority truncation design; record, don't improvise it here.
- `token-counter.ts` ratios.

## Git workflow

- Branch: `advisor/039-prompt-budget-gaps`
- Conventional Commits, e.g. `perf(gsd): cap execute-task and discuss-slice inlined context; provider-aware budgets`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Pass the provider into both `computeBudgets` call sites

- Call site 2 (~404–412): `sessionProvider` is already in scope — change to
  `computeBudgets(windowTokens, sessionProvider)`.
- Call site 1 (`resolvePromptBudgets`, ~89–100): resolve the provider the
  same way its callers do. Look at how `sessionProvider` reaches the
  ~404 site (trace its origin — likely from prefs/model profile) and reuse
  that source; if the provider is genuinely unresolvable inside
  `resolvePromptBudgets` without threading a parameter, add an optional
  `provider?: TokenProvider` parameter to `resolvePromptBudgets` and pass it
  from callers that know it (capPreamble's callers do not — leave capPreamble
  provider-less, it then keeps today's behavior, and note this in the report).
- Also update the catch-path `computeBudgets(200_000)` to forward the same
  provider when available.

**Verify**: budget tests → pass. Add a test in `context-budget.test.ts`
asserting `computeBudgets(200_000, "anthropic").totalChars <
computeBudgets(200_000, "openai").totalChars` under the heuristic path
(use the exported test hook that clears the empirical cache — see the
`_empiricalCharsPerTokenByProvider` test hook near the top of
`context-budget.ts`).

### Step 2: Cap the execute-task inlined block

In `buildExecuteTaskPrompt` (~2629–2892): identify the assembled inline
sections — `taskPlanContext` (full task plan), the slice-plan excerpt,
knowledge block, and inlined templates — and wrap their combined block in
`capPreamble(...)` before it is passed to `loadPrompt("execute-task", …)`,
mirroring the pattern at line 2462 (`renderSlicePrompt`). Preserve the
existing carry-forward truncation (~2732–2736) as-is; the cap applies to the
static inline block, with the task plan placed FIRST inside the capped string
so section-boundary truncation drops trailing (lower-priority) sections first
— order the concatenation: task plan → slice excerpt → templates → knowledge.

**Verify**: prompt tests → pass; new test (step 4) proves truncation fires.

### Step 3: Cap the discuss-slice inlined context

In `guided-flow.ts` `buildDiscussSlicePrompt`: after building `inlined`, cap
the joined block. `capPreamble` is module-private to `auto-prompts.ts` —
export it from there OR (cleaner, avoids a guided-flow→auto-prompts import if
one doesn't already exist — check `grep -n "auto-prompts" src/resources/extensions/gsd/guided-flow.ts`)
call the budget engine directly:

```ts
import { computeBudgets, truncateAtSectionBoundary } from "./context-budget.js";
...
const rawInlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;
const budget = Math.min(20_000, computeBudgets( /* window from the same resolver auto-prompts uses */ ).inlineContextBudgetChars);
const inlinedContext = rawInlinedContext.length <= budget
  ? rawInlinedContext
  : truncateAtSectionBoundary(rawInlinedContext, budget).content;
```

Prefer reusing the exported `capPreamble` if exporting it is clean (one-line
`export` change) — one cap implementation beats two. Order the `inlined`
array so the most load-bearing content survives truncation: roadmap and the
current milestone context FIRST, completed-slice summaries LAST (they are the
unbounded-growth part).

**Verify**: `pnpm run typecheck:extensions` → exit 0.

### Step 4: Tests

- Execute-task cap: build a fixture with an oversized task plan (e.g. 40K
  chars) and a small `context_window_override`; assert the built prompt's
  inline section is ≤ the computed budget and ends at a section boundary.
  Model the fixture plumbing on `auto-prompts-fallback.test.ts`.
- Discuss-slice cap: fixture with 10 fake completed-slice summaries of 6KB
  each; assert the prompt stays under the cap and that roadmap/context
  sections survive while trailing summaries are truncated.
- Provider ratio test from step 1.

**Verify**: all three targeted test files pass;
`node scripts/verify-changed-src-tests.mjs` → pass.

## Test plan

Covered in step 4. Patterns: `context-budget.test.ts` for pure budget math,
`auto-prompts-fallback.test.ts` for prompt-builder fixtures. No existing test
deletion expected; if a test asserts today's uncapped execute-task output
verbatim, update it (that assertion is the old behavior this plan removes).

## Done criteria

- [ ] `pnpm run typecheck:extensions` exits 0
- [ ] `grep -n "computeBudgets(windowTokens)" src/resources/extensions/gsd/auto-prompts.ts` returns no provider-less matches at the two production call sites
- [ ] `buildExecuteTaskPrompt` output is capped (test proves truncation on an oversized plan)
- [ ] `buildDiscussSlicePrompt` output is capped (test proves truncation with many slice summaries)
- [ ] Existing `context-budget.test.ts` and `auto-prompts-fallback.test.ts` suites pass
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The capPreamble call-site line numbers have shifted such that a cap DOES now
  exist inside `buildExecuteTaskPrompt` (someone fixed it since `43033bb9`).
- Capping the execute-task plan collides with a test or doc stating the task
  plan must NEVER be truncated (the "authoritative local execution contract"
  header suggests intent) — in that case cap everything EXCEPT the task plan
  itself and report the deviation; if the task plan alone exceeds the whole
  inline budget, that is a STOP, not a truncation.
- `truncateAtSectionBoundary` produces broken markdown on the discuss-slice
  fixture (nested fences) — report rather than hand-rolling a new truncator.

## Maintenance notes

- Anyone adding a new prompt builder should call `capPreamble` — consider a
  lint/test that greps builders for the cap (the 12-sites-but-not-13 gap this
  plan fixes is exactly the failure mode).
- Reviewers should scrutinize the section ordering choices (what gets
  truncated first) in both builders.
- Deferred follow-ups recorded in `plans/README.md`: whole-prompt final size
  gate (DISPATCH-02), probe-string over-estimation (ECON-02), carry-forward
  windowing (DISPATCH-05), template path-referencing (DISPATCH-04).
