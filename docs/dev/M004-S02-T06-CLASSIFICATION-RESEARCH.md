# M004/S02/T06 classification research

Status: implemented and verified guidance for `Classify exact changes and unresolved ambiguity`.

## Implementation boundary and T07 handoff

T06 implements the pure classification boundary and explicit complete-set facts for every supported writable row set. A self-contained, atomically valid StateManifest v1 emits full candidates and collection anchors for its scoped milestone/slice/task rows, decisions, and each present optional requirement/artifact/assessment collection. Present-empty optional collections are authoritative; omitted optionals are not. A decision-only manifest does not turn unrelated empty hierarchy arrays into permission to delete the receiving project's work.

When recognized modeled milestone or phase projections coexist, populated manifest hierarchy collections retain their complete full rows. Compatible partial projection claims coalesce behind the richer manifest candidate; conflicting fields become one row ambiguity. Projection-only hierarchy identities remain usable when the manifest's empty hierarchy arrays are unscoped and therefore non-authoritative. Assessment artifacts may own assessment interpretation, but unrelated context, lifecycle, `STATE.md`, or captured `gsd.db` bytes cannot suppress manifest requirements, artifacts, tasks, or other row identities. T07 therefore inherits explicit facts rather than inferring completeness from filenames, parser outcomes, or candidate absence; its remaining responsibility is public composition, final revalidation, and full-corpus eligibility.

## Sources and authority order

1. The canonical task row in `/Users/jeremymcspadden/.gsd/projects/d311c3f098d1/gsd.db` (`M004/S02/T06`, read through `file:...?immutable=1`) requires deterministic create/update/delete/preserve/no-op classification, delete only from an explicitly complete authoritative source, stable evidence and ordering, one resolution per diagnosis, and no applicable result while ambiguity remains. The parent Slice additionally requires a pure, exact v1 Preview and says valid ambiguity is returned rather than thrown.
2. The exact wire shape is owned by `src/resources/extensions/gsd/legacy-import-contract.ts:4-89` and `src/resources/extensions/gsd/legacy-import-contract.ts:113-195`. There is deliberately no `no_op`, `applicable`, or completeness field in the public envelope.
3. The current interpreter model is owned by `src/resources/extensions/gsd/legacy-import-preview-interpretation.ts:28-44`; candidates are either `compare` or `preserve`. Candidate identity, order, raw evidence, and diagnosis/resolution pairing are established at `src/resources/extensions/gsd/legacy-import-preview-interpretation.ts:94-104` and `src/resources/extensions/gsd/legacy-import-preview-interpretation.ts:386-415`.
4. The canonical base is one read transaction over ten allowlisted row sets (`src/resources/extensions/gsd/legacy-import-preview-base.ts:14-40`, `src/resources/extensions/gsd/legacy-import-preview-base.ts:262-283`, `src/resources/extensions/gsd/legacy-import-preview-base.ts:311-337`). It is schema-v45-only and binds revision, Authority Epoch, project identity, rows, and `relevant_rows_hash`.
5. The sealed v1 action matrix is the classification oracle: one create, one update, one delete, one preserve, and an omitted identical-row no-op (`src/resources/extensions/gsd/tests/__fixtures__/legacy-import-corpus/v1/action-matrix/oracle.json:11-18`, `:56-249`; enforced at `src/resources/extensions/gsd/tests/legacy-import-corpus.test.ts:2577-2639`).
6. The composite capstone interpreter oracle historically contains seven creates, five preserves, and three unresolved diagnoses (`src/resources/extensions/gsd/tests/__fixtures__/legacy-import-corpus/v1/composite-capstone/oracle.json:11-18`, `:166-399`). Exact classification strengthens that result to five creates and five unresolved diagnoses: the manifest's authoritative empty `/decisions` snapshot conflicts with D701, and its complete milestone snapshot conflicts with planning-only M701. Both are excluded rather than silently bypassing completeness.
7. Corpus validation owns exact ordering, evidence binding, hashes, counts, and diagnosis/resolution coverage (`src/resources/extensions/gsd/tests/helpers/legacy-import-corpus.ts:382-449`, `:451-528`). The corpus contains 26 cases (`src/resources/extensions/gsd/tests/__fixtures__/legacy-import-corpus/v1/corpus.json:1957`).

No GitHub label, tag, issue state, or hosted metadata is an input to this contract.

## Required classification truth table

`Target` means the canonical tuple `(kind, key, field-or-absent)`. `Base match` means comparison after the target-specific canonical projection described below, not arbitrary object equality.

| Candidate/evidence state | Canonical base | Complete authority for the row set | Resolution state | Result | Emitted change |
|---|---|---:|---|---|---|
| `preserve` candidate | any | any | any | Preserve retained evidence; it is not an authoritative write | `preserve`, unchanged raw/normalized/provenance/reason |
| One `compare` candidate | target absent | irrelevant | no unresolved conflict for target | Create | `create`, candidate normalized value |
| One `compare` candidate | target present, differs | irrelevant | no unresolved conflict for target | Update | `update`, candidate normalized value |
| One `compare` candidate | target present, equal | irrelevant | no unresolved conflict for target | No-op | nothing; no count and no synthetic change |
| No candidate for a base row | target present | **yes**, with a validated collection anchor | no unresolved conflict for target | Delete | `delete`, `normalized: null`, raw/provenance anchored to the complete collection |
| No candidate for a base row | target present | no/unknown | any | Preserve canonical base by inaction | nothing |
| Multiple authoritative claims for one target | any | any | claims differ or cannot be losslessly combined | Ambiguous | no create/update/delete; retain diagnosis/resolution |
| Candidate tied to unresolved conflicting target | any | any | `requires-user` or `unsupported` | Not authoritative/applicable | no create/update/delete; non-authoritative preserve evidence may remain |
| Diagnosis has `mapped`/`preserved` resolution with an explicit target | normal rules | normal rules | resolved non-user route | Classify only the named route | result from the relevant row above |

The action matrix demonstrates each positive row. D001 is absent and created; D002 exists but differs and updates; D003 exists but is absent from the complete decision collection and deletes; D004 is byte-for-byte the same producer row and disappears as a no-op; `.gsd/STATE.md` remains a preserve (`src/resources/extensions/gsd/tests/legacy-import-corpus.test.ts:2609-2635`). The delete is anchored to the exact `/decisions` array, not to an invented D003 source span (`src/resources/extensions/gsd/tests/__fixtures__/legacy-import-corpus/v1/action-matrix/oracle.json:106-171`).

## Complete authority and delete rules

Deletion must be opt-in, per source and per row set. A filename, parser ID, `mapped` outcome, unvalidated empty array, or absence from candidates is not sufficient by itself.

The only present first-party complete-snapshot format is StateManifest v1. Its required arrays are `milestones`, `slices`, `tasks`, `decisions`, and `verification_evidence`; optional arrays are allowed for backward compatibility (`src/resources/extensions/gsd/workflow-manifest.ts:60-74`, `src/resources/extensions/gsd/workflow-manifest.ts:500-527`). The current producer emits all supported arrays (`src/resources/extensions/gsd/workflow-manifest.ts:325-339`). Therefore:

| Manifest property | Base row set | Delete authority |
|---|---|---|
| `milestones` | `milestones` | yes only after complete row validation |
| `slices` | `slices` | yes only after complete row validation |
| `tasks` | `tasks` | yes only after complete row validation |
| `decisions` | `decisions` | yes only after complete row validation |
| `requirements` | `requirements` | yes only when the property is present and complete |
| `artifacts` | `artifacts` | yes only when the property is present and complete |
| `assessments` | `assessments` | yes only when the property is present and complete |
| anything else | `slice_dependencies`, `decision_memories`, `item_lifecycles`, or no row set | **no** |

An invalid or partial member invalidates completeness for that entire property; filtering bad rows and then deleting the missing base rows would be a silent-loss bug. A delete change must retain the manifest source ID, parser/version, exact collection locator, collection raw value/hash, target identity, `normalized: null`, and `complete-snapshot-row-absent` reason. An empty but validated property is authoritative; an omitted optional property is not.

The classifier should consume an explicit internal completeness record such as `{row_set, identities, raw, provenance}` produced during captured-byte interpretation. It must not reopen/reparse source files, infer completeness from path/outcome, or infer it from the candidate list.

## Target-specific base comparison

Generic deep equality is incorrect because candidates are patches and the base contains complete rows. Generic subset comparison is also unsafe because aliases and metadata are not canonical columns. Use an allowlisted target adapter that maps identity and comparable fields explicitly:

| Target kind | Base authority | Identity/comparison lean |
|---|---|---|
| `milestone` | `milestones` | key `M…`; compare only mapped milestone columns supplied by the candidate |
| `slice` | `slices` | key `M…/S…`; map aliases such as candidate `depends_on` to canonical `depends` deliberately |
| `task` | `tasks` | key `M…/S…/T…`; compare only supplied mapped task columns |
| `decision` | `decisions` | key `D…`; `seq` is producer ordering metadata and is not in the frozen base comparison (`legacy-import-preview-base.ts:75-77`) |
| `requirement` | `requirements` | key is requirement ID; compare supplied mapped columns |
| `artifact` | `artifacts` | key is path; compare mapped content fields, never infer from disk |
| `assessment` | `assessments` | derive and verify milestone/slice/task/scope identity from normalized fields, not by lossy string splitting alone |
| `milestone-status`, `slice-status`, `task-status` | `item_lifecycles` | use base project ID plus item hierarchy; compare `lifecycle_status`, because lifecycle rows are canonical authority |
| every `legacy-*`, workflow, graph, worktree, database-target, or layout evidence kind | none | preserve-only; a `compare` candidate for these is a typed classifier error |

For an existing row, missing candidate fields mean “leave unchanged,” not “set a default” and not “different.” Unknown normalized fields must be explicitly declared metadata-only or rejected; silently ignoring a new field would turn parser drift into a false no-op. JSON-backed database columns must be parsed/canonicalized by their named adapter before comparison rather than compared as formatting-sensitive text. The proven SQLite representation mismatches are `slices.is_sketch` and `tasks.blocker_discovered`: stored `0/1` is normalized to semantic `false/true`, while other numeric and nullable values remain exact so real changes are not hidden.

## Ambiguity and applicability

- Diagnoses and resolutions must be a bijection: unique diagnosis IDs, exactly one resolution for each diagnosis, and no orphan resolution. The current corpus validator checks set coverage (`src/resources/extensions/gsd/tests/helpers/legacy-import-corpus.ts:484-493`); T06 should strengthen duplicate rejection because the task explicitly says one-to-one.
- `mapped` and `preserved` are non-user resolutions. `requires-user` and `unsupported` both contribute to `counts.unresolved` (`src/resources/extensions/gsd/legacy-import-preview.ts:125-140`). The latter may be objective rather than conversational, but it still makes Application ineligible.
- The M007 capstone proves that unresolved ambiguity is valid Preview data: both sources are `unparsed`, both diagnoses are targetless `requires-user`, and there is no M007 action (`src/resources/extensions/gsd/tests/legacy-import-corpus.test.ts:2674-2691`). The unsupported database diagnosis is also valid Preview output and blocks applicability without asking a user to fix an objective schema failure.
- Preserve actions are non-authoritative evidence and may coexist with an unresolved diagnosis. Only create/update/delete must be excluded for the conflicted target.
- Do not add `applicable` to the v1 envelope: its top-level keys are exact (`src/resources/extensions/gsd/legacy-import-contract.ts:25-40`). Derive eligibility internally as `counts.unresolved === 0` plus successful structural validation and zero unresolved target conflicts. T07/S04 can expose or enforce that outside `preview_json` if needed.
- Do not throw for a well-formed ambiguity. Throw only for structural impossibility: malformed candidate/base identity, duplicate resolution, unrepresentable target, inconsistent completeness record, evidence/hash mismatch, or a compare target with no allowlisted adapter.

## ID, hash, order, and provenance invariants

1. Source IDs stay capture-derived and source order stays lexical by `(path, source_id)`. Every source has exactly one disposition (`src/resources/extensions/gsd/tests/helpers/legacy-import-corpus.ts:393-420`).
2. Candidate IDs already hash candidate semantics excluding ordinal, while ordinals are assigned after deterministic target/source/reason ordering (`src/resources/extensions/gsd/legacy-import-preview-interpretation.ts:94-104`, `:391-399`).
3. Final `change_id` should be a canonical SHA-256 of the final change identity excluding `change_id` and including the action. This avoids slug collisions and ensures create-to-update drift changes the ID. Sort changes lexically by `change_id`, matching the corpus order contract (`src/resources/extensions/gsd/tests/helpers/legacy-import-corpus.ts:397-399`).
4. The human-readable oracle IDs (`change-create-d001`, etc.) are semantic labels, not runtime capture hashes. Existing interpreter tests intentionally compare normalized semantics after replacing fixture IDs with paths (`src/resources/extensions/gsd/tests/legacy-import-preview-gsd.test.ts:216-287`, `:357-373`). T06 tests should do the same and separately assert production IDs are canonical hashes.
5. Preserve candidate raw, normalized, provenance, and parser reason unchanged. Create/update normally retain the parser reason. Complete-manifest row classification uses the action-matrix reasons `candidate-row-absent-from-base` and `candidate-row-differs-from-base`; delete uses `complete-snapshot-row-absent`.
6. Delete provenance comes from the completeness anchor. Never fabricate a locator for an absent row.
7. `source_set_hash = hash(canonically ordered sources)` and `change_set_hash = hash(canonically ordered changes)`; counts are derived, never accepted from a caller (`src/resources/extensions/gsd/legacy-import-preview.ts:125-168`). Diagnoses/resolutions are retained in the full Preview hash even though they are not in `change_set_hash` (`src/resources/extensions/gsd/legacy-import-preview.ts:178-217`).
8. Raw source ID must equal provenance source ID/parser/version, locators must bound exact retained bytes, and raw SHA-256 covers that exact span (`src/resources/extensions/gsd/tests/helpers/legacy-import-corpus.ts:428-449`). Classification must not rewrite those fields.
9. No-op candidates are omitted from `changes`; v1 has no no-op count (`src/resources/extensions/gsd/legacy-import-contract.ts:42-49`). Their source and base evidence remain sealed through `source_set_hash` and Preview identity/base row hash.

## Resolved conflicts found during research

1. **Completeness was missing from the normalized model.** T06 added internal, source-bound complete-row-set facts to `LegacyImportInterpretation`; the classifier never reparses source files or infers deletion from absence.
2. **Action-matrix manifest decisions were not candidates.** GSD interpretation now emits normalized manifest decision rows and a complete decision-set anchor at the captured-byte boundary.
3. **The base intentionally omits `decisions.seq`.** The action oracle considers D004 a no-op using complete `SELECT *` rows, but the frozen base decision projection excludes `seq`. T06 must treat `seq` as non-comparable ordering metadata unless T01's base contract is explicitly revised; do not accidentally compare the candidate object wholesale.
4. **Oracle identifiers are labels, not literal production identities.** Literal equality with `preview_id: "action-matrix"` and `change-create-d001` would conflict with the production hash convention. Semantic parity plus separate hash invariants is the consistent reading.
5. **There is no public applicability field.** Eligibility must remain derived or be represented outside the exact v1 Preview envelope.
6. **Duplicate and overlapping claims needed an explicit policy.** Compatible cross-source patches coalesce deterministically with the richest atomic row first; differing overlapping fields produce one row ambiguity and exclude the row. Equal same-source row/field evidence coalesces; contradictory same-source evidence is a structural error. A row-level unresolved route blocks its fields and dependent lifecycle claim, while a field-level unresolved route blocks an indivisible full-row patch containing that field.

## Real producer seam check

The retained-byte action-matrix seam now proves that the GSD interpreter's real decision candidates and `/decisions` completeness anchor classify against a read-only extraction of the fixture's v45 database as one create, one update, one delete, one preserve, and an omitted D004 no-op (`src/resources/extensions/gsd/tests/legacy-import-preview.test.ts`). This closes the earlier risk that only hand-built classifier candidates matched the oracle.

The corresponding real composite seam is also green. Combining the actual planning, GSD, and supplemental interpretations produces five creates, five preserves, three unparsed sources, and five unresolved diagnoses while excluding M007 plus completeness-conflicted D701 and M701. The planning interpreter recognizes arbitrary valid `## Milestone M…: ...` plus `- Phase …: ...` grammar without weakening malformed or multiple-entry rejection (`src/resources/extensions/gsd/legacy-import-preview-planning.ts`; fixture at `src/resources/extensions/gsd/tests/__fixtures__/legacy-import-corpus/v1/composite-capstone/source/.planning/ROADMAP.md`).

Known T07 boundary: noncanonical `legacy-phase-*` hierarchy targets still fail loudly rather than being guessed into milestone/slice/task IDs. The public full-corpus composition must either retain those as explicitly non-applicable evidence or obtain a deterministic canonical identity; it must not loosen canonical key parsing silently.

## Recommended lean

Keep T06 small and deterministic:

1. Add one pure classifier with explicit target adapters and no filesystem/database access.
2. Extend the internal interpretation result just enough to carry validated per-row-set authoritative snapshot facts; add manifest decision candidates at the existing captured-byte GSD interpretation boundary.
3. Validate all interpretation/base/completeness identities first, group overlapping claims by canonical storage row, exclude unresolved conflicts, then classify create/update/no-op. Generate deletes in a second pass only from explicit complete-set facts. Append preserve candidates unchanged.
4. Generate content-addressed final IDs, sort once, derive hashes/counts once, deep-freeze once.
5. Treat Preview applicability as a derived guard, not a wire change. Preserve valid ambiguity and objective unsupported diagnoses as reviewable Preview output.
6. Test the full truth table plus sabotage: remove completeness, omit one manifest array, duplicate a resolution, duplicate/conflict a target, change only D004 `seq`, change a comparable D004 field, corrupt a delete anchor, reverse inputs, add an unknown target/normalized field, and prove the action-matrix/composite semantic oracles still match.

This lean avoids three unsafe shortcuts: absence-based deletion, generic object comparison, and ambiguity inferred away by source precedence.
