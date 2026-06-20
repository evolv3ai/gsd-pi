/**
 * Live workflow: tiny pre-seeded milestone, real agent, single-unit dispatch.
 *
 * Seeds a one-slice/one-task milestone whose task is "make answer() return
 * 42" (the bundled test fails until then), then dispatches ONE unit with
 * `gsd headless next` — a real agent turn that edits the code and passes the
 * host-owned verification gate, after which step-mode exits 0. We use `next`
 * rather than `auto` deliberately: `auto` would loop into milestone closeout,
 * which is built around human-gated checkpoints that don't resolve in
 * non-supervised headless mode (the agent's closeout turn hangs with no
 * output). `next` exercises the real agent through the real dispatch +
 * verification gates without that interactive tail.
 *
 * Proof is durable only — never agent prose: exit code + the task's own
 * verification command + git history.
 *
 * Exit: 0 pass · 77 skip (no creds) · non-zero fail.
 */
import assert from "node:assert/strict";

import { seedTinyMilestone } from "./harness.ts";
import { runLiveWorkflowScenario } from "./scenario.ts";

function shouldRequireToolEvents(): boolean {
  return process.env.GSD_LIVE_WORKFLOW_OUTPUT === "stream-json";
}

const result = await runLiveWorkflowScenario({
  slug: "live-tiny-milestone",
  seed: seedTinyMilestone,
  expect: {
    commits: "increased",
    toolEvents: shouldRequireToolEvents() ? "required" : "optional",
  },
});

try {
  console.log("PASS: live agent completed the dispatched task and verification passes.");
  if (shouldRequireToolEvents()) {
    assert.ok(result.events.length > 0, "expected stream-json live run to save parseable events");
  }
} finally {
  result.project.cleanup();
}
