// gsd-pi — Integration-branch META lives OUTSIDE milestones/<MID>/ (ADR-045).
// Verifies the relocation from milestones/<MID>/<MID>-META.json to the flat
// .gsd/<MID>-META.json so it can never poison isLegacyMilestonesLayout.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { readIntegrationBranch, writeIntegrationBranch } from "../git-service.js";
import { gsdRoot, isLegacyMilestonesLayout } from "../paths.js";

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "gsd-meta-loc-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

test("write goes to the new flat .gsd/<MID>-META.json, not milestones/<MID>/", () => {
  writeIntegrationBranch(repo, "M001", "main");

  assert.ok(
    existsSync(join(gsdRoot(repo), "M001-META.json")),
    "META written to flat .gsd/<MID>-META.json",
  );
  assert.ok(
    !existsSync(join(gsdRoot(repo), "milestones", "M001", "M001-META.json")),
    "no META in legacy milestones/<MID>/ location",
  );
});

test("round-trip: read returns what write recorded", () => {
  writeIntegrationBranch(repo, "M001", "main");
  assert.equal(readIntegrationBranch(repo, "M001"), "main");
});

test("read falls back to the legacy milestones/<MID>/ location", () => {
  const legacyDir = join(gsdRoot(repo), "milestones", "M001");
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(
    join(legacyDir, "M001-META.json"),
    JSON.stringify({ integrationBranch: "develop" }) + "\n",
    "utf-8",
  );

  assert.equal(readIntegrationBranch(repo, "M001"), "develop");
});

test("writing META does not create milestones/<MID>/ or flip layout detection", () => {
  assert.equal(isLegacyMilestonesLayout(repo), false, "clean tree is not legacy layout");
  writeIntegrationBranch(repo, "M001", "main");
  assert.equal(
    isLegacyMilestonesLayout(repo),
    false,
    "writing integration-branch META must not poison layout detection",
  );
});
