import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPresets, parsePresets, readPresets, writePresets, PRESETS_RELATIVE_PATH } from "./presets-file.js";
import type { PresetsRecord } from "./types.js";

const RECORD: PresetsRecord = {
  schemaVersion: 1,
  approval: {
    approvedAt: "2026-07-06T03:00:00Z",
    approvedBy: { model: "claude-code/claude-fable-5", authMode: "subscription" },
    note: "smoke run only",
    approvalHash: "abc123",
    projectedFrom: "specs/minimal.html",
  },
  history: [],
  stages: {
    orchestrator: { host: "claude-code", model: "claude-code/claude-fable-5", authMode: "subscription", skills: ["planf3"] },
    gsdBuild: {
      binary: "gsd",
      version: "1.6.0",
      buckets: [
        { bucket: "planning", model: "claude-code/claude-fable-5", source: "plan", status: "probed-ok" },
        { bucket: "execution_simple", model: "claude-code/claude-haiku-4-5", source: "global", status: "configured" },
      ],
    },
    exportStage: { generatorVersion: "0.3.0" },
    project: { root: ".", branch: "main" },
  },
  product: [{
    service: "OpenRouter",
    envVars: [{ name: "OPENROUTER_API_KEY", provenance: "env-file", file: ".env.local" }],
    guessed: false,
    injectionDisclaimer: false,
  }],
  probes: [{ target: "openrouter", tier: "auth", verdict: "ok", detail: "HTTP 200", checkedAt: "2026-07-06T03:00:00Z" }],
};

describe("presets-file round-trip", () => {
  test("parse(render(r)) is value-exact", () => {
    assert.deepEqual(parsePresets(renderPresets(RECORD)), RECORD);
  });

  test("render(parse(t)) is byte-exact for rendered documents", () => {
    const text = renderPresets(RECORD);
    assert.equal(renderPresets(parsePresets(text)), text);
  });

  test("body carries human tables (bucket + status ladder visible)", () => {
    const text = renderPresets(RECORD);
    assert.match(text, /\| planning \|/);
    assert.match(text, /probed-ok/);
    assert.match(text, /configured/);
    // the ownership boundary statement is part of the rendered body (spec §5.1)
    assert.match(text, /bridge-owned/i);
  });

  test("corrupt frontmatter throws with the preferences-overlay wording", () => {
    assert.throws(() => parsePresets("---\nversion: 1\nno closing delimiter"), /missing its closing --- delimiter/);
  });

  test("readPresets returns null when absent; writePresets round-trips via disk", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-presets-"));
    assert.equal(await readPresets(tmp), null);
    const path = await writePresets(tmp, RECORD);
    assert.equal(path, join(tmp, PRESETS_RELATIVE_PATH));
    assert.deepEqual(await readPresets(tmp), RECORD);
    assert.match(await readFile(path, "utf8"), /^---\n/);
  });
});
