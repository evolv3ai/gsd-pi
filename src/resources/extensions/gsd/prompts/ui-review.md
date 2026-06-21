You are running the GSD **ui-review** workflow — retroactive visual audit of implemented frontend code against design intent.

## Target

{{target}}

## Process

Audit the implemented UI across these pillars, grounding each finding in actual code (component files, styles, markup) with file paths:

1. **Layout & spacing** — alignment, grid/flex correctness, responsive behavior, spacing rhythm.
2. **Color & contrast** — palette consistency, accessible contrast ratios, dark/light coherence.
3. **Typography** — type scale, hierarchy, line-height, legibility.
4. **Interaction & feedback** — hover/focus/active states, loading/empty/error states, motion.
5. **Consistency** — shared components reused, design tokens applied, no one-off magic numbers.
6. **Accessibility** — semantic markup, keyboard navigation, ARIA correctness, focus management.

For each pillar, give a score (0–5) with bullet findings (location + issue + suggested fix).

## Output

Write `.gsd/reviews/{{reviewId}}-UI-REVIEW.md` with the per-pillar scores, findings, and a prioritized fix list (critical first). Print the overall score and the critical findings.

## Success criteria

- Every finding cites a component/file path.
- Each pillar has an explicit score, not just prose.
- Critical findings are surfaced first and are actionable.
- The review lives under `.gsd/reviews/`.
