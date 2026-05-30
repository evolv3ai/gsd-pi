// gsd-pi + Regression tests for checkAutoStartAfterDiscuss "ready" notify guard (R3b)
//
// Belt-and-suspenders: even when CONTEXT.md and STATE.md exist on disk, the
// "Milestone X ready." success notify must not fire when the milestone DB row
// is absent. Otherwise the user sees "ready" and then /gsd reports
// "No Active Milestone" because the milestone was never registered.

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  checkAutoStartAfterDiscuss,
  setPendingAutoStart,
  clearPendingAutoStart,
} from "../guided-flow.ts";
import { drainLogs } from "../workflow-logger.ts";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  getMilestone,
} from "../gsd-db.ts";
import {
  clearDiscussionFlowState,
  clearPendingGate,
} from "../bootstrap/write-gate.ts";

interface MockCapture {
  notifies: Array<{ msg: string; level: string }>;
  messages: Array<{ payload: any; options: any }>;
}

function mkCapture(): MockCapture {
  return { notifies: [], messages: [] };
}

function mkCtx(cap: MockCapture): any {
  return {
    ui: {
      notify: (msg: string, level: string) => {
        cap.notifies.push({ msg, level });
      },
    },
  };
}

function mkPi(cap: MockCapture): any {
  return {
    sendMessage: (payload: any, options: any) => {
      cap.messages.push({ payload, options });
    },
    setActiveTools: () => undefined,
    getActiveTools: () => [],
  };
}

function mkBase(): string {
  // realpathSync to normalize the macOS /var → /private/var symlink so the
  // basePath we pass matches what the workspace projectRoot resolves to.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-ready-guard-")));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "M001-CONTEXT.md"),
    "# M001: Ready Guard Test\n\nContext.\n",
  );
  writeFileSync(
    join(base, ".gsd", "STATE.md"),
    "# State\n\nactive: M001\n",
  );
  return base;
}

describe("checkAutoStartAfterDiscuss ready-notify DB guard (R3b)", () => {
  let base: string;
  let cap: MockCapture;

  beforeEach(() => {
    clearPendingAutoStart();
    drainLogs();
  });

  afterEach(() => {
    closeDatabase();
    clearPendingAutoStart();
    if (base) {
      try { clearDiscussionFlowState(base); } catch { /* */ }
      try { clearPendingGate(base); } catch { /* */ }
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("does not announce 'ready' when the milestone DB row is absent — recovers via Gate 1b", () => {
    base = mkBase();
    // Open a fresh in-memory DB but DO NOT insertMilestone for M001.
    openDatabase(":memory:");

    cap = mkCapture();
    setPendingAutoStart(base, {
      basePath: base,
      milestoneId: "M001",
      ctx: mkCtx(cap),
      pi: mkPi(cap),
    });

    const result = checkAutoStartAfterDiscuss();
    assert.equal(result, false, "must return false when DB row missing");

    // No success "ready" notify
    const successReady = cap.notifies.find(
      (n) => n.level === "success" && /ready\.?$/i.test(n.msg),
    );
    assert.equal(successReady, undefined, "must not announce 'ready' when DB row missing");

    // When CONTEXT.md is on disk the R3b path recovers: it inserts a placeholder
    // "queued" row (so Gate 1b can retry gsd_plan_milestone) and emits a warning.
    const recovered = getMilestone("M001");
    assert.ok(recovered, "R3b recovery must insert a placeholder 'queued' DB row");
    assert.equal(recovered!.status, "queued", "placeholder row must have status 'queued'");

    const warnNotify = cap.notifies.find((n) => n.level === "warning");
    assert.ok(warnNotify, "must emit a warning notify during R3b recovery");
    assert.match(warnNotify!.msg, /M001/, "warning must mention the milestone id");
    assert.match(warnNotify!.msg, /recovering/i, "warning must mention recovery");
  });

  test("announces 'ready' when DB row exists", () => {
    base = mkBase();
    openDatabase(":memory:");
    insertMilestone({ id: "M001", title: "Ready Guard Test", status: "active" });

    cap = mkCapture();
    setPendingAutoStart(base, {
      basePath: base,
      milestoneId: "M001",
      ctx: mkCtx(cap),
      pi: mkPi(cap),
    });

    const result = checkAutoStartAfterDiscuss();
    assert.equal(result, true, "must return true on the happy path");

    const successReady = cap.notifies.find(
      (n) => n.level === "success" && /Milestone\s+M001\s+ready/i.test(n.msg),
    );
    assert.ok(successReady, "must announce 'Milestone M001 ready.' on success");
  });
});
