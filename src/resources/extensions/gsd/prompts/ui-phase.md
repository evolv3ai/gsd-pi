You are running the GSD **ui-phase** workflow — produce a UI design contract (UI-SPEC) for a frontend milestone/slice before implementation.

## Target

{{target}}

## Process

1. **Load intent.** Read the milestone/slice goal, requirements, and any existing brand/design references.

2. **Inventory the surfaces.** List every screen/state/component the milestone touches: pages, key states (empty, loading, error, success), and shared components.

3. **Define the design contract per surface:**
   - Layout (structure, responsive behavior)
   - Key interactions and their feedback states
   - Content/copy essentials
   - Accessibility requirements
   - Entry/exit points to other surfaces

4. **Align on constraints.** Brand, type scale, color tokens, spacing system, component library — use existing design tokens where they exist; flag gaps.

5. **Write the UI-SPEC** by calling `gsd_summary_save` with `artifact_type: "UI-SPEC"` and the applicable `milestone_id` / `slice_id`. This persists the milestone/slice UI design contract to the computed `.gsd/` artifact path before implementation planning. Recommend `/gsd sketch` to prototype high-uncertainty surfaces, or `/gsd plan-phase` to plan implementation.

## Success criteria

- Every surface the milestone touches is inventoried.
- Each surface's contract is concrete enough to implement against.
- Existing design tokens are reused; gaps are flagged.
- The recommended next step reflects design readiness.
