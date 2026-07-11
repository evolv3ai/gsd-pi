import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseSyncArgs, severityFor } from "./sync-register.js";

describe("parseSyncArgs", () => {
  test("empty -> no path, no dry-run", () => {
    assert.deepEqual(parseSyncArgs(""), { htmlPath: null, dryRun: false });
  });
  test("path only", () => {
    assert.deepEqual(parseSyncArgs("specs/plan.html"), { htmlPath: "specs/plan.html", dryRun: false });
  });
  test("--dry-run only", () => {
    assert.deepEqual(parseSyncArgs("--dry-run"), { htmlPath: null, dryRun: true });
  });
  test("path and flag in either order", () => {
    assert.deepEqual(parseSyncArgs("specs/plan.html --dry-run"), { htmlPath: "specs/plan.html", dryRun: true });
    assert.deepEqual(parseSyncArgs("--dry-run specs/plan.html"), { htmlPath: "specs/plan.html", dryRun: true });
  });
});

describe("severityFor", () => {
  test("maps outcome kinds to emit severities", () => {
    assert.equal(severityFor("synced"), "success");
    assert.equal(severityFor("no-change"), "info");
    assert.equal(severityFor("dry-run"), "info");
    assert.equal(severityFor("not-observable"), "info");
    assert.equal(severityFor("aborted"), "error");
    assert.equal(severityFor("not-located"), "error");
  });
});
