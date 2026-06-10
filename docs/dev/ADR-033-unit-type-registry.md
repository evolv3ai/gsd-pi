<!-- Project/App: gsd-pi -->
<!-- File Purpose: ADR for the Unit Registry — one declarative descriptor per Unit type; existing tables become derived views. -->

# ADR-033: Unit Registry — One Declaration per Unit Type

**Status:** Accepted
**Date:** 2026-06-10
**Author:** GSD architecture review
**Related:** ADR-015 (Tool Contract module), ADR-026 (per-phase thinking level), CONTEXT.md "Phase (model-routing bucket)"

## Context

### Five parallel tables define "what a Unit type is"

Adding or changing one of the 23 Unit types means editing, by hand, with
nothing checking agreement:

1. `unit-context-manifest.ts:19-41` — `KNOWN_UNIT_TYPES` (the type union's
   source).
2. `unit-context-manifest.ts:38-542` — `UNIT_MANIFESTS` (skills, knowledge,
   memory, budgets per type).
3. `unit-tool-contracts.ts:49-195` — `UNIT_TOOL_CONTRACTS` (allowed /
   required / forbidden tools per type).
4. `auto-unit-tool-scope.ts:18-33` — hand-maintained membership Sets
   (`EXECUTE_TASK_UNIT_TYPES`, `SECTION_CLOSE_GATE_UNIT_TYPES`).
5. `prompts/*.md` (43 files) + `auto-prompts.ts` (4,133 lines, 63
   `buildXxxPrompt()` builders) — the prompt template and its assembly,
   associated by naming convention.

Plus the Phase routing key (Unit → model-routing bucket) consumed by
model selection and ADR-026's `(model, thinking)` resolution.

The interface to the "Unit type" concept is as wide as its implementation —
the definition of a shallow module. The triage synthesis already names the
symptom: "prompt/tool/schema drift causes repeated invalid calls."

### Relation to the Tool Contract module (ADR-015)

ADR-015 decided a Tool Contract module that *compiles* a per-Unit contract
(prompt obligations, allowed tools, schema enums, validation, closeout tools)
before dispatch. That compiler currently has to gather its inputs from the
five tables above. This ADR gives it a single input.

## Decision

### 1. One `UnitDescriptor` per Unit type, in one registry

```ts
// unit-registry.ts
interface UnitDescriptor {
  prompt: string;                      // template file in prompts/
  toolContract: UnitToolSurfaceContract;
  manifest: UnitContextManifest;
  scopeClass: "execute-task" | "section-close" | "standard";
  phase: Phase;                        // model-routing bucket (ADR-026)
}

const UNIT_REGISTRY: Record<UnitType, UnitDescriptor> = { ... };
export type UnitType = keyof typeof UNIT_REGISTRY;
```

### 2. The existing tables become derived views

The same barrel discipline as the `gsd-db.ts` split: import paths stay
stable, implementations become lookups.

- `KNOWN_UNIT_TYPES` → `Object.keys(UNIT_REGISTRY)`.
- `UNIT_TOOL_CONTRACTS` / `UNIT_MANIFESTS` → projections of the registry.
- The membership Sets → derived from `scopeClass` (membership is declared on
  the Unit, not maintained in a distant Set).
- Prompt association → `descriptor.prompt`, checked at registry load: every
  declared template must exist on disk. The 63 prompt builders keep their
  composition logic but resolve the base template through the descriptor.

### 3. Parity becomes one table-driven test

One test iterates the registry and asserts: template exists, tool contract
references only registered tools, manifest budgets are sane, every Unit maps
to a valid Phase. The current possibility — a Unit type present in three
tables and missing from the fourth — becomes unrepresentable.

### 4. What stays out

- Prompt *composition* (context blocks, gate inlining, skill activation)
  stays in `auto-prompts.ts` and its helpers — that is real per-Unit
  behaviour, not declaration.
- Dispatch rules, recovery policy, and the Tool Contract *compiler* are
  consumers of the registry, not residents.

## Consequences

- **Interface shrinks:** adding a Unit type = one registry row + one
  template file. Today: 4–7 files.
- **Locality:** a Unit's prompt, tool surface, scope membership, and routing
  change in one diff, reviewable as one unit of meaning.
- **Leverage for ADR-015:** the Tool Contract compiler reads one source;
  prompt/policy/schema parity tests collapse into the registry parity test.
- **Migration:** mechanical — introduce the registry with entries copied from
  the five tables, flip each table to a derived view, then delete the
  hand-maintained Sets. No behaviour change at any step.

## Implementation status (2026-06-10)

**Shipped this pass** (`unit-registry.ts` + parity test
`tests/unit-registry.test.ts`):

- The registry owns `UnitType`/`KNOWN_UNIT_TYPES`, the tool contracts, the
  scope-class Sets, and the unit→phase chain (`phaseChainForUnit` now reads
  the descriptor; `worktree-merge` and `subagent/*` stay as non-Unit
  fallbacks).
- Migration surfaced real drift the old tables had accumulated, preserved
  explicitly: `discuss-slice` and `execute-task-simple` had contracts and
  Set membership but were missing from `KNOWN_UNIT_TYPES` (now
  `kind: "variant"`); `triage-captures` and `quick-task` had manifests but
  no contract and no phase routing (now `toolContract: null`,
  `phaseChain: null`).

**Deferred:**

- `UNIT_MANIFESTS` data stays in `unit-context-manifest.ts` — it is already
  type-enforced against the registry's `UnitType` (a missing/extra manifest
  is a compile error), so consolidation is locality-only and large.
- Prompt-template association (`descriptor.prompt`) — the true unit→template
  mapping is implicit across the 63 builders in `auto-prompts.ts`; declaring
  it without verifying each association would pin wrong data.
