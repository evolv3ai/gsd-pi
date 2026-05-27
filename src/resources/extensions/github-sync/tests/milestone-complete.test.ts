import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  closeMilestoneOnGitHub,
  finalizeMilestoneGitHubSync,
  _resetConfigCache,
  _setGhCloseOverridesForTest,
} from "../sync.ts";
import {
  _resetGhCache,
  _setGhAvailableForTest,
  _setGhRateLimitOkForTest,
} from "../cli.ts";
import {
  createEmptyMapping,
  getMilestoneRecord,
  loadSyncMapping,
  setMilestoneRecord,
} from "../mapping.ts";
import type { MilestoneSyncRecord } from "../types.ts";

function openMilestoneRecord(): MilestoneSyncRecord {
  return {
    issueNumber: 10,
    ghMilestoneNumber: 3,
    lastSyncedAt: "2025-01-01T00:00:00Z",
    state: "open",
  };
}

describe("milestone GitHub closeout", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gsd-gh-milestone-close-"));
    mkdirSync(join(tmpDir, ".gsd"), { recursive: true });
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    _resetGhCache();
    _resetConfigCache();
    _setGhAvailableForTest(true);
    _setGhRateLimitOkForTest(true);
    _setGhCloseOverridesForTest(null);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    _setGhCloseOverridesForTest(null);
    _setGhAvailableForTest(null);
    _setGhRateLimitOkForTest(null);
    _resetGhCache();
    _resetConfigCache();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("closeMilestoneOnGitHub marks mapping closed only when both closes succeed", () => {
    const mapping = createEmptyMapping("owner/repo");
    setMilestoneRecord(mapping, "M001", openMilestoneRecord());

    _setGhCloseOverridesForTest({
      closeIssue: () => ({ ok: true }),
      closeMilestone: () => ({ ok: true }),
    });

    assert.equal(closeMilestoneOnGitHub(tmpDir, mapping, "M001"), true);
    const record = getMilestoneRecord(mapping, "M001");
    assert.equal(record?.state, "closed");
    assert.equal(record?.lastSyncError, undefined);
  });

  it("closeMilestoneOnGitHub leaves mapping open when issue close fails", () => {
    const mapping = createEmptyMapping("owner/repo");
    setMilestoneRecord(mapping, "M001", openMilestoneRecord());

    _setGhCloseOverridesForTest({
      closeIssue: () => ({ ok: false, error: "issue close failed" }),
      closeMilestone: () => ({ ok: true }),
    });

    assert.equal(closeMilestoneOnGitHub(tmpDir, mapping, "M001"), false);
    const record = getMilestoneRecord(mapping, "M001");
    assert.equal(record?.state, "open");
    assert.match(record?.lastSyncError ?? "", /issue close failed/);
  });

  it("closeMilestoneOnGitHub leaves mapping open when milestone close fails", () => {
    const mapping = createEmptyMapping("owner/repo");
    setMilestoneRecord(mapping, "M001", openMilestoneRecord());

    _setGhCloseOverridesForTest({
      closeIssue: () => ({ ok: true }),
      closeMilestone: () => ({ ok: false, error: "milestone close failed" }),
    });

    assert.equal(closeMilestoneOnGitHub(tmpDir, mapping, "M001"), false);
    const record = getMilestoneRecord(mapping, "M001");
    assert.equal(record?.state, "open");
    assert.match(record?.lastSyncError ?? "", /milestone close failed/);
  });

  it("finalizeMilestoneGitHubSync is idempotent when mapping already closed", async () => {
    writeFileSync(
      join(tmpDir, ".gsd", "PREFERENCES.md"),
      ["---", "version: 1", "github:", "  enabled: true", "  repo: owner/repo", "---"].join("\n"),
      "utf-8",
    );

    const mapping = createEmptyMapping("owner/repo");
    setMilestoneRecord(mapping, "M001", { ...openMilestoneRecord(), state: "closed" });
    writeFileSync(join(tmpDir, ".gsd", "github-sync.json"), JSON.stringify(mapping, null, 2), "utf-8");

    let closeCalls = 0;
    _setGhCloseOverridesForTest({
      closeIssue: () => {
        closeCalls++;
        return { ok: true };
      },
      closeMilestone: () => {
        closeCalls++;
        return { ok: true };
      },
    });

    await finalizeMilestoneGitHubSync(tmpDir, "M001");
    assert.equal(closeCalls, 0);
    const loaded = loadSyncMapping(tmpDir);
    assert.equal(loaded?.milestones.M001?.state, "closed");
  });

  it("finalizeMilestoneGitHubSync persists closed mapping on success", async () => {
    writeFileSync(
      join(tmpDir, ".gsd", "PREFERENCES.md"),
      ["---", "version: 1", "github:", "  enabled: true", "  repo: owner/repo", "---"].join("\n"),
      "utf-8",
    );

    const mapping = createEmptyMapping("owner/repo");
    setMilestoneRecord(mapping, "M001", openMilestoneRecord());
    writeFileSync(join(tmpDir, ".gsd", "github-sync.json"), JSON.stringify(mapping, null, 2), "utf-8");

    _setGhCloseOverridesForTest({
      closeIssue: () => ({ ok: true }),
      closeMilestone: () => ({ ok: true }),
    });

    await finalizeMilestoneGitHubSync(tmpDir, "M001");
    const loaded = loadSyncMapping(tmpDir);
    assert.equal(loaded?.milestones.M001?.state, "closed");
    assert.equal(loaded?.milestones.M001?.lastSyncError, undefined);
  });
});
