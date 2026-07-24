// Project/App: gsd-pi
// File Purpose: Verifies session bootstrap fails closed on unrepresented legacy Markdown.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { registerHooks } from "../bootstrap/register-hooks.ts";
import { closeDatabase, insertMilestone, openDatabase } from "../gsd-db.ts";

type HookHandler = (event: unknown, ctx: any) => Promise<void> | void;

function createSessionStartHandler(): HookHandler {
  const handlers = new Map<string, HookHandler>();
  const pi = {
    on(event: string, handler: HookHandler) {
      handlers.set(event, handler);
    },
  };

  registerHooks(pi as any, []);
  const sessionStart = handlers.get("session_start");
  assert.ok(sessionStart, "session_start handler should be registered");
  return sessionStart;
}

function makeContext(basePath: string) {
  return {
    cwd: basePath,
    hasUI: false,
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      setWorkingMessage: () => {},
      onTerminalInput: () => () => {},
    },
    model: null,
    modelRegistry: {
      setDisabledModelProviders: () => {},
    },
    sessionManager: {
      getSessionId: () => null,
    },
    setCompactionThresholdOverride: () => {},
  };
}

test("session_start rejects unrepresented legacy Markdown with explicit recovery guidance", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-bootstrap-flat-migration-"));
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-CONTEXT.md"), "# M001: Foundation\n", "utf-8");
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Foundation", status: "active" });
  closeDatabase();

  writeFileSync(join(base, ".gsd-backups"), "not a directory\n", "utf-8");

  const sessionStart = createSessionStartHandler();

  await assert.rejects(
    () => Promise.resolve(sessionStart({}, makeContext(base))),
    /flat-phase migration.*\/gsd recover/,
  );
  assert.ok(existsSync(join(base, ".gsd", "milestones", "M001")), "legacy layout should remain for recovery");
});
