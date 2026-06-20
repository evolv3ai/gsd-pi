import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  _resetPreferenceDiagnosticNotificationsForTests,
  notifyPreferenceDiagnostics,
} from "../preferences-diagnostics.ts";
import { _resetParseWarningFlag } from "../preferences.ts";

test("notifyPreferenceDiagnostics dedupes within a surface but re-surfaces across surfaces", (t) => {
  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;
  const tempProject = mkdtempSync(join(tmpdir(), "gsd-prefs-notify-project-"));
  const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-prefs-notify-home-"));
  t.after(() => {
    process.chdir(originalCwd);
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempGsdHome, { recursive: true, force: true });
    _resetPreferenceDiagnosticNotificationsForTests();
    _resetParseWarningFlag();
  });

  mkdirSync(join(tempProject, ".gsd"), { recursive: true });
  process.env.GSD_HOME = tempGsdHome;
  process.chdir(tempProject);
  _resetPreferenceDiagnosticNotificationsForTests();
  _resetParseWarningFlag();

  writeFileSync(
    join(tempProject, ".gsd", "PREFERENCES.md"),
    "---\nversion: 3\n---\n",
    "utf-8",
  );

  const notifications: Array<{ message: string; type?: string }> = [];
  const ctx = {
    ui: {
      notify(message: string, type?: "info" | "warning" | "error" | "success") {
        notifications.push({ message, type });
      },
    },
  };

  assert.equal(
    notifyPreferenceDiagnostics(ctx, tempProject, { surface: "session-start" }),
    1,
  );
  assert.equal(
    notifyPreferenceDiagnostics(ctx, tempProject, { surface: "session-start" }),
    0,
  );
  assert.equal(
    notifyPreferenceDiagnostics(ctx, tempProject, { surface: "auto-preflight" }),
    1,
  );
  assert.equal(notifications.length, 2);
  assert.equal(notifications[0]!.type, "error");
  assert.match(notifications[0]!.message, /GSD project preferences error/);
  assert.match(notifications[0]!.message, /unsupported version 3/);
  assert.match(notifications[0]!.message, /Run \/gsd doctor for details/);
  assert.equal(notifications[1]!.message, notifications[0]!.message);
});
