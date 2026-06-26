You are running the GSD **profile-user** workflow — generate a developer behavioral profile to personalize GSD's defaults, and persist it so future sessions use it.

## Flags

- `--questionnaire` — {{questionnaireFlag}} (run the full questionnaire instead of inferring)
- `--refresh` — {{refreshFlag}} (re-profile even if a profile exists)

## Process

1. **Check for an existing profile.** If one exists and `--refresh` is off, show it and ask whether to refresh.

2. **Gather the profile.** Either run the structured questionnaire (`--questionnaire`) or infer from the session + recent activity. Capture:
   - Preferred verbosity (concise vs. thorough).
   - Risk appetite (prefer safe/verified vs. fast/experimental).
   - Commit style and granularity.
   - Testing preference (TDD-first vs. test-after).
   - Review preference (self-review only vs. convergence/multi-reviewer).
   - Preferred tools/runtimes and any to avoid.

3. **Map the profile to gsd-pi preferences.** Translate each preference to the matching gsd-pi setting (auto-mode behavior, commit granularity, review depth, model tier hints) via `/gsd prefs`.

4. **Persist.** Write the profile into gsd-pi preferences so future sessions apply it. Print a summary of what was set.

## Success criteria

- The profile captures concrete preferences, not vague adjectives.
- Each preference maps to an actual gsd-pi setting (no orphan preferences).
- The profile persists in preferences, not a throwaway file.
