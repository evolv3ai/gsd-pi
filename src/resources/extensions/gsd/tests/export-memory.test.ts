import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { writeExportFile } from "../export.ts";
import { closeDatabase, openDatabase } from "../gsd-db.ts";
import { createMemory } from "../memory-store.ts";

function mockTokens() {
  return { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 };
}

test("writeExportFile includes active memories in markdown exports", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-export-memory-"));
  try {
    const largeContent = "Exported reports should include memory rows. " + "A".repeat(2500);
    const filePath = writeExportFile(base, "markdown", {
      totals: {
        units: 1,
        tokens: mockTokens(),
        cost: 0.01,
        duration: 1000,
        toolCalls: 1,
        assistantMessages: 1,
        userMessages: 1,
      },
      byPhase: [
        { phase: "execution", units: 1, tokens: mockTokens(), cost: 0.01, duration: 1000 },
      ],
      bySlice: [
        { sliceId: "M001/S01", units: 1, tokens: mockTokens(), cost: 0.01, duration: 1000 },
      ],
      byModel: [],
      units: [
        {
          type: "execute-task",
          id: "M001/S01/T01",
          model: "claude-sonnet",
          startedAt: 0,
          finishedAt: 1000,
          tokens: mockTokens(),
          cost: 0.01,
          toolCalls: 1,
          assistantMessages: 1,
          userMessages: 1,
        },
      ],
      memories: {
        totalCount: 1,
        entries: [
          {
            id: "MEM001",
            category: "gotcha",
            content: largeContent,
            confidence: 0.9,
            hitCount: 2,
            scope: "M001/S01",
            tags: ["export", "memory"],
            updatedAt: "2026-06-21T00:00:00.000Z",
          },
        ],
      },
    });

    assert.ok(filePath);
    const markdown = readFileSync(filePath, "utf-8");
    assert.match(markdown, /## Memories/);
    assert.match(markdown, /Active memories: 1/);
    assert.match(markdown, /MEM001/);
    assert.match(markdown, /Exported reports should include memory rows/);
    assert.doesNotMatch(markdown, new RegExp(`A{${2500}}`));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("writeExportFile reads project DB memories when no visualizer payload is supplied", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-export-memory-db-"));
  try {
    const gsdDir = join(base, ".gsd");
    mkdirSync(gsdDir, { recursive: true });
    writeFileSync(
      join(gsdDir, "metrics.json"),
      JSON.stringify({
        version: 1,
        projectStartedAt: Date.now(),
        units: [
          {
            type: "execute-task",
            id: "M001/S01/T01",
            model: "claude-sonnet",
            startedAt: 0,
            finishedAt: 1000,
            tokens: mockTokens(),
            cost: 0.01,
            toolCalls: 1,
            assistantMessages: 1,
            userMessages: 1,
          },
        ],
      }),
    );

    openDatabase(join(gsdDir, "gsd.db"));
    createMemory({
      category: "pattern",
      content: "Shared markdown export reads memories from the project DB",
      confidence: 0.86,
      tags: ["export"],
    });
    closeDatabase();

    const filePath = writeExportFile(base, "markdown");

    assert.ok(filePath);
    const markdown = readFileSync(filePath, "utf-8");
    assert.match(markdown, /## Memories/);
    assert.match(markdown, /MEM001/);
    assert.match(markdown, /Shared markdown export reads memories from the project DB/);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("writeExportFile includes bounded memories in json exports", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-export-memory-json-"));
  try {
    const gsdDir = join(base, ".gsd");
    mkdirSync(gsdDir, { recursive: true });
    writeFileSync(
      join(gsdDir, "metrics.json"),
      JSON.stringify({
        version: 1,
        projectStartedAt: Date.now(),
        units: [
          {
            type: "execute-task",
            id: "M001/S01/T01",
            model: "claude-sonnet",
            startedAt: 0,
            finishedAt: 1000,
            tokens: mockTokens(),
            cost: 0.01,
            toolCalls: 1,
            assistantMessages: 1,
            userMessages: 1,
          },
        ],
      }),
    );

    openDatabase(join(gsdDir, "gsd.db"));
    const largeContent = "JSON export should carry memory rows. " + "B".repeat(2500);
    createMemory({
      category: "pattern",
      content: largeContent,
      confidence: 0.86,
      tags: ["export"],
    });
    closeDatabase();

    const filePath = writeExportFile(base, "json");

    assert.ok(filePath);
    const report = JSON.parse(readFileSync(filePath, "utf-8"));
    assert.equal(report.memories.totalCount, 1);
    assert.equal(report.memories.entries[0].id, "MEM001");
    assert.match(report.memories.entries[0].content, /JSON export should carry memory rows/);
    assert.ok(report.memories.entries[0].content.length < largeContent.length);
    assert.ok(report.memories.entries[0].content.length <= 2003);
    assert.ok(report.memories.entries[0].content.endsWith("..."));
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
