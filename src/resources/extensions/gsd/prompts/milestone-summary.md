You are running the GSD **milestone-summary** workflow — generate a comprehensive project summary from milestone artifacts for onboarding and review.

## Target

{{target}}

## Process

1. **Gather artifacts.** Read the target milestone's ROADMAP entry, CONTEXT, RESEARCH, per-slice SUMMARY/ASSESSMENT, the Decisions Register, and any UAT/validation outcomes. If no target, summarize the whole project across milestones.

2. **Synthesize the summary** covering:
   - What the milestone/project set out to do (intent + requirements).
   - What was delivered (slices, key changes, by area).
   - Key decisions made and why (from the Decisions Register).
   - Verification outcomes (tests, UAT, audits).
   - Known gaps, deferred work, and tech debt.
   - Onboarding notes: how to run, where things live, gotchas.

3. **Write the summary** to `.gsd/summaries/` and print it. For a milestone, name it after the milestone id; for a project, name it with the date.

4. **Recommend next steps** based on the summary (next milestone, remediation, archive).

## Success criteria

- The summary is grounded in artifacts, not memory.
- Decisions and gaps are included, not just the happy-path deliverables.
- Onboarding notes are concrete (commands, paths) not vague.
