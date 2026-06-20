// gsd-pi — Regression test for PR #562 / issue #561
//
// Before the fix, models-resolver.ts fell back to ~/.pi/agent/models.json
// and resource-loader.ts scanned ~/.pi/agent/extensions/ for pi extensions.
// Both were runtime isolation violations: GSD loading pi's config/extensions
// caused import failures (pi extensions import @earendil-works/pi-coding-agent
// which doesn't resolve in GSD's module graph).
//
// This test guards against regressions where GSD accidentally re-introduces
// runtime dependencies on ~/.pi/ directories.
//
// NOTE: models-resolver.ts computes GSD_MODELS_PATH at module load time from
// app-paths.ts, which reads GSD_HOME env var. Because Node caches ES modules,
// we set GSD_HOME BEFORE any import and use a single test runner invocation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";

// ─── Setup: isolated temp GSD_HOME ──────────────────────────────────────────

const tmp = mkdtempSync(join(tmpdir(), "gsd-regression-"));
const gsdHome = join(tmp, ".gsd");

// Set GSD_HOME before importing app-paths (which evaluates at module load).
// app-paths.ts: `export const appRoot = process.env.GSD_HOME || join(homedir(), '.gsd')`
process.env.GSD_HOME = gsdHome;

// ─── Import after env is configured ─────────────────────────────────────────

// These evaluate their module-level constants using our GSD_HOME.
// app-paths is the leaf dependency — imported first by models-resolver.
const { resolveModelsJsonPath } = await import("../models-resolver.ts");

// ─── Cleanup ────────────────────────────────────────────────────────────────

// node:test does not support top-level after(), but since each test file runs
// in its own process (test isolation), cleanup happens automatically when the
// process exits. We still clean up to avoid temp dir accumulation.
process.on("exit", () => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Best-effort — temp dirs are cleaned by the OS eventually
  }
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function createFakePiModelsJson(): string {
  const piAgentDir = join(tmp, ".pi", "agent");
  mkdirSync(piAgentDir, { recursive: true });
  const path = join(piAgentDir, "models.json");
  writeFileSync(
    path,
    JSON.stringify({ source: "pi", marker: "SHOULD_NOT_BE_USED" }),
  );
  return path;
}

function createGsdModelsJson(content: Record<string, unknown>): string {
  const gsdAgentDir = join(gsdHome, "agent");
  mkdirSync(gsdAgentDir, { recursive: true });
  const path = join(gsdAgentDir, "models.json");
  writeFileSync(path, JSON.stringify(content));
  return path;
}

function removeGsdModelsJson(): void {
  const path = join(gsdHome, "agent", "models.json");
  try {
    rmSync(path, { force: true });
  } catch {
    // OK if doesn't exist
  }
}

function removePiDir(): void {
  const piDir = join(tmp, ".pi");
  try {
    rmSync(piDir, { recursive: true, force: true });
  } catch {
    // OK if doesn't exist
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test("resolveModelsJsonPath always returns the GSD models.json path", () => {
  const result = resolveModelsJsonPath();

  assert.equal(
    result,
    join(gsdHome, "agent", "models.json"),
    "resolveModelsJsonPath must return the GSD_HOME agent dir models.json",
  );
});

test("resolveModelsJsonPath returns GSD path when only ~/.pi/ models.json exists (no GSD file)", () => {
  // Remove any GSD models.json, create pi one
  removeGsdModelsJson();
  removePiDir();
  createFakePiModelsJson();

  const result = resolveModelsJsonPath();

  // Must be the GSD path, NOT pi
  assert.ok(
    !result.includes(".pi"),
    `Path must not reference .pi, got: ${result}`,
  );
  assert.equal(
    result,
    join(gsdHome, "agent", "models.json"),
    "Must return GSD path even when GSD models.json doesn't exist",
  );
});

test("resolveModelsJsonPath returns GSD path with correct content when both files exist", () => {
  removePiDir();
  removeGsdModelsJson();

  createFakePiModelsJson();
  createGsdModelsJson({ source: "gsd", marker: "CORRECT" });

  const result = resolveModelsJsonPath();

  // Verify the resolved path points to the GSD file with GSD content
  const content = JSON.parse(readFileSync(result, "utf-8"));
  assert.equal(
    content.source,
    "gsd",
    `Should read GSD models.json, got: ${JSON.stringify(content)}`,
  );
  assert.equal(
    content.marker,
    "CORRECT",
    "Must not fall back to ~/.pi/agent/models.json content",
  );
});

test("resolveModelsJsonPath returns GSD path when neither file exists", () => {
  removePiDir();
  removeGsdModelsJson();

  const result = resolveModelsJsonPath();

  assert.equal(
    result,
    join(gsdHome, "agent", "models.json"),
    "Must return GSD path even when neither file exists",
  );
});
