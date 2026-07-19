import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parsePlanf3Html } from "../parser/planf3-html-parser.js";
import { exportGsdSpec, PF3_TAG_INSTRUCTION } from "./gsd-spec-exporter.js";

const here = dirname(fileURLToPath(import.meta.url));
const minimal = readFileSync(
  join(here, "..", "fixtures", "minimal-plan.html"),
  "utf8",
);

const CTX = {
  htmlPath: "specs/minimal.html",
  manifestPath: "specs/minimal.manifest.json",
  generatedAt: "2026-06-22T12:00:00Z",
};

describe("exportGsdSpec", () => {
  test("emits H1 title, source block, objective, problem, and proposed solution", () => {
    const md = exportGsdSpec(parsePlanf3Html(minimal), CTX);
    assert.match(md, /^# Minimal Plan\n/);
    assert.match(md, /## Source\n\n- Planf3 HTML: specs\/minimal\.html\n- Manifest: specs\/minimal\.manifest\.json\n- Generated: 2026-06-22T12:00:00Z\n/);
    assert.match(md, /## Objective\n\nVerify the parser\./);
    assert.match(md, /## Problem\n\nNeed a deterministic fixture\./);
    assert.match(md, /## Proposed Solution\n\nHandwrite one\./);
  });

  test("emits relevant files with kind tags", () => {
    const md = exportGsdSpec(parsePlanf3Html(minimal), CTX);
    assert.match(md, /## Relevant Files\n\n### Existing Files\n- `src\/a\.ts` — current entry\./);
    assert.match(md, /### New Files\n- `src\/b\.ts` — parser output\./);
  });

  test("emits implementation phases with task checklists", () => {
    const md = exportGsdSpec(parsePlanf3Html(minimal), CTX);
    assert.match(md, /### Phase 1: Setup \[wip\] \[tier: mechanical\] \[PF3-P1\]\n\nStand up the skeleton\./);
    assert.match(md, /#### 1\. Scaffolding \[tier: complex\] \[PF3-P1-T1\]\n- \[x\] Create the dir\.\n- \[ \] Add the file\./);
    assert.match(md, /### Phase 2: Wire-up \[ \] \[PF3-P2\]/);
  });

  test("emits a tier legend when any tier chip is present", () => {
    const md = exportGsdSpec(parsePlanf3Html(minimal), CTX);
    assert.match(md, /## Implementation Phases\n\n_Tier hints: \[tier: mechanical\] = simplest capable model/);
  });

  test("emits the Model Policy section from the plan's policy map", () => {
    const md = exportGsdSpec(parsePlanf3Html(minimal), CTX);
    assert.match(md, /## Model Policy\n\n_These routing directives are applied to \.gsd\/PREFERENCES\.md at build time\._\n- planning: `openrouter\/anthropic\/claude-opus-4\.7`\n- execution: `openrouter\/x-ai\/grok-code-fast-1`/);
  });

  test("emits validation commands", () => {
    const md = exportGsdSpec(parsePlanf3Html(minimal), CTX);
    assert.match(md, /## Validation Commands\n- pnpm run verify:pr/);
  });

  test("is deterministic across two calls with identical inputs (parses twice)", () => {
    // C3: parse twice independently to exercise determinism through the parser
    const planA = parsePlanf3Html(minimal);
    const planB = parsePlanf3Html(minimal);
    assert.equal(exportGsdSpec(planA, CTX), exportGsdSpec(planB, CTX));
  });

  test("phase and task headings carry trailing PF3 tags", () => {
    const out = exportGsdSpec(parsePlanf3Html(minimal), CTX);
    // order pinned: title, marker, optional tier, PF3 tag LAST
    assert.match(out, /^### .+ \[PF3-P1\]$/m);
    assert.match(out, /^#### .+ \[PF3-P1-T1\]$/m);
  });

  test("instruction block appears once, near the top, with pinned wording", () => {
    const out = exportGsdSpec(parsePlanf3Html(minimal), CTX);
    assert.ok(out.includes(PF3_TAG_INSTRUCTION));
    assert.ok(out.indexOf(PF3_TAG_INSTRUCTION) < out.indexOf("## Objective"));
    assert.equal(out.split("Do not invent tags").length, 2); // exactly once
  });
});
