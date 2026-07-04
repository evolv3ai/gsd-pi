import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { mergePreferences, applyPreferencesOverlay, type OverlayInput } from "./preferences-overlay.js";

const INPUT: OverlayInput = {
  modelPolicy: {
    planning: "openrouter/anthropic/claude-opus-4.7",
    execution: "openrouter/x-ai/grok-code-fast-1",
  },
  verificationCommands: ["pnpm run verify:pr", "pnpm run typecheck:extensions"],
  sourceHtmlPath: "specs/minimal.html",
};

function frontmatterOf(content: string): Record<string, unknown> {
  assert.ok(content.startsWith("---\n"), "content starts with frontmatter");
  const end = content.indexOf("\n---", 4);
  assert.notEqual(end, -1, "frontmatter is closed");
  return parseYaml(content.slice(4, end)) as Record<string, unknown>;
}

describe("mergePreferences", () => {
  test("creates a fresh preferences file when none exists", () => {
    const result = mergePreferences(null, INPUT);
    assert.equal(result.changed, true);
    assert.deepEqual(result.appliedModels, ["planning", "execution"]);
    assert.deepEqual(result.appliedCommands, INPUT.verificationCommands);
    const fm = frontmatterOf(result.content);
    assert.equal(fm.version, 1);
    assert.deepEqual(fm.models, {
      planning: "openrouter/anthropic/claude-opus-4.7",
      execution: "openrouter/x-ai/grok-code-fast-1",
    });
    assert.deepEqual(fm.verification_commands, INPUT.verificationCommands);
    assert.match(result.content, /Managed in part by planf3-gsd \(source plan: specs\/minimal\.html\)/);
  });

  test("merges into an existing file, preserving unrelated keys and the body", () => {
    const existing = [
      "---",
      "version: 1",
      "token_profile: quality",
      "models:",
      "  planning: anthropic/claude-opus-4-8",
      "  research: anthropic/claude-opus-4-8",
      "verification_commands:",
      "  - pnpm run verify:pr",
      "---",
      "",
      "# My Preferences",
      "",
      "Hand-written notes stay put.",
      "",
    ].join("\n");
    const result = mergePreferences(existing, INPUT);
    assert.equal(result.changed, true);
    // planning changes value, execution is new; research untouched
    assert.deepEqual(result.appliedModels, ["planning", "execution"]);
    // verify:pr already present, only typecheck is appended
    assert.deepEqual(result.appliedCommands, ["pnpm run typecheck:extensions"]);
    const fm = frontmatterOf(result.content);
    assert.equal(fm.token_profile, "quality");
    assert.deepEqual(fm.models, {
      planning: "openrouter/anthropic/claude-opus-4.7",
      research: "anthropic/claude-opus-4-8",
      execution: "openrouter/x-ai/grok-code-fast-1",
    });
    assert.deepEqual(fm.verification_commands, [
      "pnpm run verify:pr",
      "pnpm run typecheck:extensions",
    ]);
    assert.match(result.content, /Hand-written notes stay put\./);
  });

  test("recognizes CRLF-encoded frontmatter delimiters", () => {
    const existing = [
      "---",
      "version: 1",
      "token_profile: quality",
      "models:",
      "  planning: anthropic/claude-opus-4-8",
      "---",
      "",
      "# Notes",
      "",
      "Body line with CRLF.",
    ].join("\r\n");
    const result = mergePreferences(existing, INPUT);
    assert.equal(result.changed, true);
    assert.deepEqual(result.appliedModels, ["planning", "execution"]);
    const fm = frontmatterOf(result.content);
    assert.equal(fm.token_profile, "quality");
    assert.deepEqual(fm.models, {
      planning: "openrouter/anthropic/claude-opus-4.7",
      execution: "openrouter/x-ai/grok-code-fast-1",
    });
    assert.deepEqual(fm.verification_commands, INPUT.verificationCommands);
  });

  test("is a no-op when policy and commands are already present", () => {
    const first = mergePreferences(null, INPUT);
    const second = mergePreferences(first.content, INPUT);
    assert.equal(second.changed, false);
    assert.deepEqual(second.appliedModels, []);
    assert.deepEqual(second.appliedCommands, []);
  });

  test("keeps a frontmatter-less file's content as the body", () => {
    const existing = "# Just notes\n\nNo frontmatter here.\n";
    const result = mergePreferences(existing, INPUT);
    const fm = frontmatterOf(result.content);
    assert.equal(fm.version, 1);
    assert.match(result.content, /No frontmatter here\./);
  });

  test("throws on an unclosed frontmatter block", () => {
    assert.throws(
      () => mergePreferences("---\nversion: 1\nno closing delimiter\n", INPUT),
      /missing its closing/,
    );
  });

  test("dedupes verification commands within the input before applying", () => {
    const result = mergePreferences(null, {
      ...INPUT,
      verificationCommands: ["pnpm test", "pnpm test", "pnpm run lint"],
    });
    assert.deepEqual(result.appliedCommands, ["pnpm test", "pnpm run lint"]);
    const fm = frontmatterOf(result.content);
    assert.deepEqual(fm.verification_commands, ["pnpm test", "pnpm run lint"]);
  });
});

describe("applyPreferencesOverlay", () => {
  test("writes the merged file under .gsd/ and is idempotent", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-prefs-"));
    const first = await applyPreferencesOverlay(tmp, INPUT);
    assert.equal(first.changed, true);
    const onDisk = await readFile(join(tmp, ".gsd", "PREFERENCES.md"), "utf8");
    assert.equal(onDisk, first.content);

    const second = await applyPreferencesOverlay(tmp, INPUT);
    assert.equal(second.changed, false);
    const stillOnDisk = await readFile(join(tmp, ".gsd", "PREFERENCES.md"), "utf8");
    assert.equal(stillOnDisk, onDisk);
  });

  test("preserves an existing project preferences file's other keys", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-prefs2-"));
    await mkdir(join(tmp, ".gsd"), { recursive: true });
    await writeFile(
      join(tmp, ".gsd", "PREFERENCES.md"),
      "---\nversion: 1\nplanning_depth: deep\n---\n\nBody text.\n",
      "utf8",
    );
    const result = await applyPreferencesOverlay(tmp, INPUT);
    assert.equal(result.changed, true);
    const fm = frontmatterOf(await readFile(join(tmp, ".gsd", "PREFERENCES.md"), "utf8"));
    assert.equal(fm.planning_depth, "deep");
  });
});
