// Project/App: gsd-pi
// File Purpose: Regression coverage for volatile system-context message routing.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { buildContextMessage, stripVolatileCodebaseMetadata } from "../bootstrap/system-context.ts";

describe("stripVolatileCodebaseMetadata (#847 — KV cache stability)", () => {
  const map = [
    "# Codebase Map",
    "",
    "Generated: 2026-03-23T14:00:00Z | Files: 3 | Described: 2/3",
    `<!-- gsd:codebase-meta {"generatedAt":"2026-03-23T14:00:00Z","fingerprint":"abc","fileCount":3,"truncated":false} -->`,
    "",
    "### src/",
    "- `a.ts` — does a",
    "- `b.ts`",
  ].join("\n");

  test("removes the Generated timestamp and meta comment lines", () => {
    const stripped = stripVolatileCodebaseMetadata(map);
    assert.ok(!stripped.includes("Generated:"));
    assert.ok(!stripped.includes("gsd:codebase-meta"));
    assert.ok(stripped.includes("- `a.ts` — does a"));
    assert.ok(stripped.includes("### src/"));
  });

  test("is stable across regenerations that only change the timestamp", () => {
    const later = map
      .replace("2026-03-23T14:00:00Z | Files", "2026-03-24T09:30:00Z | Files")
      .replace('"generatedAt":"2026-03-23T14:00:00Z"', '"generatedAt":"2026-03-24T09:30:00Z"');
    assert.equal(stripVolatileCodebaseMetadata(map), stripVolatileCodebaseMetadata(later));
  });
});

describe("buildContextMessage (#5019 — memory routing)", () => {
  const markedMemory = "[GSD Context Metadata]\n- Memory supplied: yes\n\n[MEMORY]\nrule one";

  test("returns null when nothing to inject", () => {
    const result = buildContextMessage({
      memoryBlock: "",
      injection: null,
      forensicsInjection: null,
    });
    assert.equal(result, null);
  });

  test("whitespace-only memoryBlock counts as empty", () => {
    const result = buildContextMessage({
      memoryBlock: "   \n\n   ",
      injection: null,
      forensicsInjection: null,
    });
    assert.equal(result, null);
  });

  test("memory-only path emits gsd-memory message with trimmed content", () => {
    const result = buildContextMessage({
      memoryBlock: "\n\n[MEMORY]\nrule one\nrule two\n\n",
      injection: null,
      forensicsInjection: null,
    });
    assert.ok(result, "expected a context message");
    assert.equal(result.customType, "gsd-memory");
    assert.equal(result.content, "[GSD Context Metadata]\n- Memory supplied: yes\n\n[MEMORY]\nrule one\nrule two");
    assert.equal(result.display, false);
  });

  test("guided-execute injection alone emits gsd-guided-context", () => {
    const result = buildContextMessage({
      memoryBlock: "",
      injection: "[GUIDED]\nexecute T01",
      forensicsInjection: null,
    });
    assert.ok(result);
    assert.equal(result.customType, "gsd-guided-context");
    assert.equal(result.content, "[GUIDED]\nexecute T01");
  });

  test("forensics injection alone emits gsd-forensics", () => {
    const result = buildContextMessage({
      memoryBlock: "",
      injection: null,
      forensicsInjection: "[FORENSICS]\ninvestigation context",
    });
    assert.ok(result);
    assert.equal(result.customType, "gsd-forensics");
    assert.equal(result.content, "[FORENSICS]\ninvestigation context");
  });

  test("memory + guided injection: memory prepended, customType is gsd-guided-context", () => {
    const result = buildContextMessage({
      memoryBlock: "[MEMORY]\nrule one",
      injection: "[GUIDED]\nexecute T01",
      forensicsInjection: null,
    });
    assert.ok(result);
    assert.equal(result.customType, "gsd-guided-context");
    assert.equal(result.content, `${markedMemory}\n\n[GUIDED]\nexecute T01`);
  });

  test("memory + forensics: memory prepended, customType is gsd-forensics", () => {
    const result = buildContextMessage({
      memoryBlock: "[MEMORY]\nrule one",
      injection: null,
      forensicsInjection: "[FORENSICS]\ninvestigation context",
    });
    assert.ok(result);
    assert.equal(result.customType, "gsd-forensics");
    assert.equal(result.content, `${markedMemory}\n\n[FORENSICS]\ninvestigation context`);
  });

  test("guided takes precedence over forensics when both are somehow present", () => {
    // The caller in buildBeforeAgentStartResult already gates forensics on
    // `!injection`, but the helper's documented priority is guided > forensics.
    // Test the contract directly so a future refactor can't silently flip it.
    const result = buildContextMessage({
      memoryBlock: "",
      injection: "[GUIDED]",
      forensicsInjection: "[FORENSICS]",
    });
    assert.ok(result);
    assert.equal(result.customType, "gsd-guided-context");
    assert.equal(result.content, "[GUIDED]");
  });
});
