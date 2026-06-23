import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parsePlanf3Html } from "../parser/planf3-html-parser.ts";
import { exportGsdSpec } from "./gsd-spec-exporter.ts";

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
    assert.match(md, /### Phase 1: Setup \[wip\]\n\nStand up the skeleton\./);
    assert.match(md, /#### 1\. Scaffolding\n- \[x\] Create the dir\.\n- \[ \] Add the file\./);
    assert.match(md, /### Phase 2: Wire-up \[ \]/);
  });

  test("emits validation commands", () => {
    const md = exportGsdSpec(parsePlanf3Html(minimal), CTX);
    assert.match(md, /## Validation Commands\n- pnpm run verify:pr/);
  });

  test("is deterministic across two calls with identical inputs", () => {
    const plan = parsePlanf3Html(minimal);
    assert.equal(exportGsdSpec(plan, CTX), exportGsdSpec(plan, CTX));
  });
});
