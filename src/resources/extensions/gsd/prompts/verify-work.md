You are running the GSD **verify-work** workflow — validate built features through conversational UAT.

## Target

{{target}}

## Process

1. **Load what was built.** Read the target slice/milestone plan and SUMMARY to understand what features were delivered and what their acceptance criteria are.

2. **Draft a UAT script.** Turn each acceptance criterion into a concrete, observable test step the human can perform (or that you can perform via tooling where possible). Group by feature; order so earlier steps set up later ones.

3. **Walk through the script conversationally.** Present one step (or a small group) at a time. For each, record the outcome: `pass`, `fail` (with what happened), `blocked` (with the blocker), or `skipped` (intentionally). Do not advance past a fail without acknowledging it.

4. **Where you can self-verify** (deterministic checks: type checks, tests, lint, schema), run them and include the result alongside the human step.

5. **Produce the verdict.** After all steps: `pass` (all criteria met), `needs-attention` (some steps failed but none blocking), or `needs-remediation` (a blocking failure). Record the UAT outcome against the slice via the appropriate gsd-pi mechanism.

## Success criteria

- Every acceptance criterion becomes a concrete, observable step.
- Outcomes are recorded honestly — fails are not hidden.
- Deterministic checks are run where possible, not just asked about.
- The final verdict maps to a canonical gsd-pi outcome.
