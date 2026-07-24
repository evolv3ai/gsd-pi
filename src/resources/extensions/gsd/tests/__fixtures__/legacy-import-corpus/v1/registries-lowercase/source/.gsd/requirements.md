# Requirements

## Active

### R001 — Durable project authority
- Class: core-capability
- Status: active
- Description: Persist workflow truth in one local database.
- Why it matters: Agents must resume without projection drift.
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: M001/S02
- Validation: unmapped
- Notes: Markdown is a projection.

### R001 — Competing duplicate
- Status: active
- Description: Treat markdown as workflow truth.
- Primary owner: M009/S09

### R01A — Malformed requirement identifier
- Status: active
- Description: This heading must not become a requirement.

## Validated

### NET-01 — Network path verified
- Status: validated
- Description: The offline handoff path has executable proof.
- Validated by: M002/S01
- Proof: Focused handoff test passed.

## Deferred

### R030 — Remote synchronization
- Status: deferred
- Description: Replicate canonical state to another machine.
- Primary owner: none
- Supporting_slices: none
- Validation: unmapped

### R050 — Conflicting status evidence
- Status: active
- Description: The section and bullet disagree about scheduling.
- Primary_owner: M003/S01

## Out of Scope

### R040 — Hosted control plane
- Status: out-of-scope
- Description: Do not require a hosted service.
- Primary_owner: none
- Supporting slices: none
- Validation: n/a
