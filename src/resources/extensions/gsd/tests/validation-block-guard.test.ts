// Project/App: gsd-pi
// File Purpose: Regression tests for validation-blocked command gating.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  formatValidationBlockedMessage,
  getValidationBlockMessageForBase,
  isValidationBlockAllowedCommand,
  isValidationBlockedState,
} from "../validation-block-guard.ts";
import {
  _getAdapter,
  closeDatabase,
  insertMilestone,
  insertSlice,
  openDatabase,
} from "../gsd-db.ts";
import { invalidateStateCache } from "../state.ts";
import type { GSDState } from "../types.ts";
import { cleanup, makeTempDir } from "./test-utils.ts";

function blockedState(): GSDState {
  return {
    activeMilestone: { id: "M006", title: "Mark All Complete" },
    activeSlice: null,
    activeTask: null,
    phase: "blocked",
    recentDecisions: [],
    blockers: [
      [
        "Milestone M006 is blocked because milestone validation returned needs-attention.",
        "Fix options:",
        "1. Review the validation details: `/gsd status`",
        "2. If you fixed the missing evidence or issue, re-run milestone validation: `/gsd validate-milestone`",
        "3. If the finding is acceptable, override it: `/gsd verdict pass --rationale \"why this is okay\"`",
        "4. If this should wait, defer it explicitly: `/gsd park M006`",
      ].join("\n"),
    ],
    nextAction: "Resolve M006 validation attention before proceeding.",
    registry: [],
    requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
    progress: {
      milestones: { done: 0, total: 1 },
      slices: { done: 1, total: 1 },
    },
  };
}

function makeBase(): string {
  const base = makeTempDir("gsd-validation-block-");
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function seedNonBlockedMilestone(base: string): void {
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Active Milestone", status: "active" });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Pending Slice",
    status: "pending",
    risk: "low",
    depends: [],
  });
  invalidateStateCache();
}

test("validation block detection only matches validation blockers", () => {
  assert.equal(isValidationBlockedState(blockedState()), true);
  assert.equal(isValidationBlockedState({
    ...blockedState(),
    blockers: ["No slice eligible because dependencies are incomplete."],
  }), false);
});

test("validation block allows recovery, diagnostics, and unrelated commands", () => {
  const allowed = [
    "help",
    "h",
    "?",
    "status",
    "verdict pass --rationale ok",
    "validate-milestone",
    "dispatch reassess",
    "dispatch reassess-roadmap",
    "dispatch validate",
    "dispatch validate-milestone",
    "park M006",
    "logs debug",
    "notifications",
    "inspect",
    "doctor audit",
    "forensics",
    "capture validation false-positive on Android",
    "knowledge lesson browser gate needs Android evidence",
    "codebase update",
    "prefs status",
    "config",
    "discuss M006",
    "queue",
    "quick fix docs typo",
    "new-milestone",
    "new-project",
    "workflow list",
    "workflow validate release-checklist",
    "parallel status",
    "parallel stop M007",
    "parallel pause M007",
    "parallel watch",
    "progress",
    "progress --forensic",
    // code-review is allowed when not applying fixes
    "code-review",
    "code-review --depth deep",
    // audit-fix is allowed in dry-run mode (read-only review, no commits)
    "audit-fix --dry-run",
    // docs-update is allowed in verify-only mode (read-only check, no writes)
    "docs-update --verify-only",
    // phase read-only subcommands are fine while validation-blocked
    "phase",
    "phase list",
    "phase status",
  ];

  for (const command of allowed) {
    assert.equal(isValidationBlockAllowedCommand(command), true, command);
  }
});

test("validation block rejects workflow-start and advancing commands", () => {
  const blocked = [
    "",
    "auto",
    "auto --verbose",
    "next",
    "next M006",
    "do mark all complete",
    "progress --next",
    'progress --do "mark all complete"',
    "start bugfix",
    "plan-phase",
    "execute-phase --milestone M009",
    "autonomous --from 1",
    "spec-phase M009",
    "mvp-phase --milestone M009",
    "ui-phase M009",
    "ai-integration-phase M009",
    "ultraplan-phase M009",
    "plan-review-convergence M009",
    "resume-work",
    "workflow resume",
    "workflow run release-checklist",
    "workflow release-checklist",
    "workflow release-checklist env=prod",
    "parallel start",
    "parallel resume",
    "parallel merge",
    "dispatch complete",
    "dispatch uat",
    "complete-milestone",
    "ship",
    // code-review --fix applies changes and should be blocked
    "code-review --fix",
    "code-review --depth deep --fix",
    // audit-fix without --dry-run applies fixes and commits
    "audit-fix",
    "audit-fix --verbose",
    // mutating workflow-advancing commands added in v2
    "discuss-phase",
    "discuss-phase M006",
    "import",
    "import milestones.json",
    "ingest-docs",
    "ingest-docs --path docs/",
    "review-backlog",
    "secure-phase",
    "secure-phase --milestone M006",
    // docs-update without --verify-only applies writes
    "docs-update",
    "docs-update --milestone M006",
    // phase mutating subcommands change milestone queue state and must be blocked
    "phase add M009",
    "phase create M009",
    "phase new",
    "phase insert M009 after M008",
    "phase remove M008",
    "phase edit M008",
  ];

  for (const command of blocked) {
    assert.equal(isValidationBlockAllowedCommand(command), false, command);
  }
});

test("validation block message includes attempted command and recovery options", () => {
  const message = formatValidationBlockedMessage(blockedState(), "next");

  assert.ok(message);
  assert.match(message, /\/gsd next cannot run/);
  assert.match(message, /\/gsd status/);
  assert.match(message, /\/gsd validate-milestone/);
  assert.match(message, /\/gsd verdict pass --rationale/);
  assert.match(message, /\/gsd park M006/);
});

test("validation block message can guide remediation through dispatch reassess", () => {
  const message = formatValidationBlockedMessage({
    ...blockedState(),
    blockers: [
      [
        "Milestone M006 is blocked because milestone validation returned needs-remediation, but all slices are complete.",
        "Fix options:",
        "1. Run `/gsd dispatch reassess` to add remediation slices, then run `/gsd auto`",
        "2. If the finding is acceptable, override it: `/gsd verdict pass --rationale \"why this is okay\"`",
        "3. If this should wait, defer it explicitly: `/gsd park M006`",
      ].join("\n"),
    ],
  }, "auto");

  assert.ok(message);
  assert.match(message, /\/gsd dispatch reassess/);
  assert.doesNotMatch(message, /gsd_reassess_roadmap/);
});

test("validation block guard does not refresh the database when state is not blocked", async () => {
  const base = makeBase();
  try {
    seedNonBlockedMilestone(base);
    const adapterBefore = _getAdapter();
    assert.ok(adapterBefore);

    const message = await getValidationBlockMessageForBase(base, "next");

    assert.equal(message, null);
    assert.equal(
      _getAdapter(),
      adapterBefore,
      "non-blocked validation guard should not close and reopen the active database",
    );
  } finally {
    closeDatabase();
    invalidateStateCache();
    cleanup(base);
  }
});
