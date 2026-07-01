import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";

import {
  parseCodebaseMap,
  parseCodebaseMapMetadata,
  generateCodebaseMap,
  updateCodebaseMap,
  writeCodebaseMap,
  readCodebaseMap,
  getCodebaseMapStats,
  ensureCodebaseMapFresh,
} from "../codebase-generator.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeTmpRepo(): string {
  const base = join(tmpdir(), `gsd-codebase-test-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  execSync("git init", { cwd: base, stdio: "ignore" });
  return base;
}

function addFile(base: string, path: string, content = ""): void {
  const fullPath = join(base, path);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content || `// ${path}\n`, "utf-8");
  execSync(`git add "${path}"`, { cwd: base, stdio: "ignore" });
}

function cleanup(base: string): void {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* */ }
}

// ─── parseCodebaseMap ────────────────────────────────────────────────────

test("parseCodebaseMap: parses file with description", () => {
  const content = `# Codebase Map

### src/
- \`main.ts\` — Application entry point
- \`utils.ts\` — Shared utilities
`;

  const map = parseCodebaseMap(content);
  assert.equal(map.size, 2);
  assert.equal(map.get("main.ts"), "Application entry point");
  assert.equal(map.get("utils.ts"), "Shared utilities");
});

test("parseCodebaseMap: parses file without description", () => {
  const content = `- \`config.ts\`\n- \`index.ts\` — Entry\n`;
  const map = parseCodebaseMap(content);
  assert.equal(map.size, 2);
  assert.equal(map.get("config.ts"), "");
  assert.equal(map.get("index.ts"), "Entry");
});

test("parseCodebaseMap: empty content returns empty map", () => {
  const map = parseCodebaseMap("");
  assert.equal(map.size, 0);
});

test("parseCodebaseMap: ignores non-matching lines", () => {
  const content = `# Codebase Map\n\nGenerated: 2026-03-23\n\n### src/\n- \`file.ts\` — desc\n`;
  const map = parseCodebaseMap(content);
  assert.equal(map.size, 1);
});

test("parseCodebaseMap: recovers descriptions from collapsed-description comments", () => {
  const content = `# Codebase Map

### src/components/
- *(25 files: 25 .ts)*
<!-- gsd:collapsed-descriptions
- \`src/components/Foo.ts\` — The Foo component
- \`src/components/Bar.ts\` — The Bar component
-->
`;
  const map = parseCodebaseMap(content);
  assert.equal(map.get("src/components/Foo.ts"), "The Foo component");
  assert.equal(map.get("src/components/Bar.ts"), "The Bar component");
  // The collapsed summary line itself should not be parsed as a file
  assert.ok(!map.has("*(25 files: 25 .ts)*"));
});

test("parseCodebaseMap: handles corrupted/malformed input gracefully", () => {
  const content = [
    "- `unclosed backtick",
    "- `` — empty filename",
    "- `valid.ts` — ok",
    "random garbage line",
    "- `a.ts` — desc with other text",
  ].join("\n");
  const map = parseCodebaseMap(content);
  assert.ok(map.has("valid.ts"));
  assert.ok(map.has("a.ts"));
  // Malformed lines should be silently skipped
  assert.equal(map.size, 2);
});

// ─── generateCodebaseMap ─────────────────────────────────────────────────

test("generateCodebaseMap: generates from git ls-files", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    addFile(base, "src/utils.ts");
    addFile(base, "README.md");

    const result = generateCodebaseMap(base);
    assert.ok(result.content.includes("# Codebase Map"));
    assert.ok(result.content.includes("`src/main.ts`"));
    assert.ok(result.content.includes("`src/utils.ts`"));
    assert.ok(result.content.includes("README.md"));
    assert.equal(result.fileCount, 3);
    assert.equal(result.truncated, false);
    assert.equal(result.files.length, 3);
  } finally {
    cleanup(base);
  }
});

test("generateCodebaseMap: excludes .gsd/ files", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    addFile(base, ".gsd/PROJECT.md");

    const result = generateCodebaseMap(base);
    assert.ok(result.content.includes("`src/main.ts`"));
    assert.ok(!result.content.includes("PROJECT.md"));
  } finally {
    cleanup(base);
  }
});

test("generateCodebaseMap: excludes .claude/ and other tool directories", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    addFile(base, ".claude/CLAUDE.md");
    addFile(base, ".claude/memory/user.md");
    addFile(base, ".plans/plan.md");
    addFile(base, ".cursor/settings.json");
    addFile(base, ".vscode/settings.json");

    const result = generateCodebaseMap(base);
    assert.ok(result.content.includes("`src/main.ts`"), "should include src/main.ts");
    assert.ok(!result.content.includes("CLAUDE.md"), "should exclude .claude/ files");
    assert.ok(!result.content.includes("user.md"), "should exclude .claude/memory/ files");
    assert.ok(!result.content.includes(".plans"), "should exclude .plans/ files");
    assert.ok(!result.content.includes(".cursor"), "should exclude .cursor/ files");
    assert.ok(!result.content.includes(".vscode"), "should exclude .vscode/ files");
  } finally {
    cleanup(base);
  }
});

test("generateCodebaseMap: excludes .agents/ and other tooling directories", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    addFile(base, ".agents/skills/pdf/SKILL.md");
    addFile(base, ".agents/skills/find-skills/SKILL.md");
    addFile(base, ".bg-shell/session.json");
    addFile(base, ".idea/workspace.xml");
    addFile(base, ".cache/data.bin");
    addFile(base, "tmp/scratch.ts");
    addFile(base, "target/debug/build.rs");
    addFile(base, "venv/lib/site.py");

    const result = generateCodebaseMap(base);
    assert.ok(result.content.includes("`src/main.ts`"), "should include src/main.ts");
    assert.ok(!result.content.includes("SKILL.md"), "should exclude .agents/ files");
    assert.ok(!result.content.includes(".bg-shell"), "should exclude .bg-shell/ files");
    assert.ok(!result.content.includes(".idea"), "should exclude .idea/ files");
    assert.ok(!result.content.includes(".cache"), "should exclude .cache/ files");
    assert.ok(!result.content.includes("tmp/"), "should exclude tmp/ files");
    assert.ok(!result.content.includes("target"), "should exclude target/ files");
    assert.ok(!result.content.includes("venv"), "should exclude venv/ files");
    assert.equal(result.fileCount, 1);
  } finally {
    cleanup(base);
  }
});

test("generateCodebaseMap: excludes binary and lock files", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    addFile(base, "package-lock.json"); // .json not excluded
    addFile(base, "yarn.lock");         // .lock excluded
    addFile(base, "assets/logo.png");   // .png excluded

    const result = generateCodebaseMap(base);
    assert.ok(result.content.includes("`src/main.ts`"));
    assert.ok(result.content.includes("package-lock.json"));
    assert.ok(!result.content.includes("yarn.lock"));
    assert.ok(!result.content.includes("logo.png"));
  } finally {
    cleanup(base);
  }
});

test("generateCodebaseMap: respects custom excludePatterns", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    addFile(base, "docs/guide.md");
    addFile(base, "docs/api.md");

    const result = generateCodebaseMap(base, { excludePatterns: ["docs/"] });
    assert.ok(result.content.includes("`src/main.ts`"));
    assert.ok(!result.content.includes("guide.md"));
    assert.ok(!result.content.includes("api.md"));
    assert.equal(result.fileCount, 1);
  } finally {
    cleanup(base);
  }
});

test("generateCodebaseMap: preserves existing descriptions", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    addFile(base, "src/utils.ts");

    const descriptions = new Map<string, string>();
    descriptions.set("src/main.ts", "App entry point");

    const result = generateCodebaseMap(base, undefined, descriptions);
    assert.ok(result.content.includes("`src/main.ts` — App entry point"));
    assert.ok(result.content.includes("`src/utils.ts`"));
  } finally {
    cleanup(base);
  }
});

test("generateCodebaseMap: writes freshness metadata comment", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");

    const result = generateCodebaseMap(base);
    const metadata = parseCodebaseMapMetadata(result.content);

    assert.ok(metadata, "metadata comment should be present");
    assert.equal(metadata?.fileCount, 1);
    assert.equal(metadata?.truncated, false);
    assert.equal(typeof metadata?.fingerprint, "string");
    assert.ok(metadata?.generatedAt?.endsWith("Z"));
  } finally {
    cleanup(base);
  }
});

test("generateCodebaseMap: collapses large directories", () => {
  const base = makeTmpRepo();
  try {
    for (let i = 0; i < 25; i++) {
      addFile(base, `src/components/comp${String(i).padStart(2, "0")}.ts`);
    }

    const result = generateCodebaseMap(base);
    // Collapsed summary should appear
    assert.ok(result.content.includes("*(25 files: 25 .ts)*"));
    // Individual file entries should NOT appear in main body
    assert.ok(!result.content.includes("`src/components/comp00.ts`\n"));
  } finally {
    cleanup(base);
  }
});

test("generateCodebaseMap: respects custom collapseThreshold", () => {
  const base = makeTmpRepo();
  try {
    for (let i = 0; i < 5; i++) addFile(base, `src/comp${i}.ts`);

    // Low threshold: 5 files should collapse
    const collapsed = generateCodebaseMap(base, { collapseThreshold: 3 });
    assert.ok(collapsed.content.includes("5 files"));

    // High threshold: 5 files should expand
    const expanded = generateCodebaseMap(base, { collapseThreshold: 10 });
    assert.ok(expanded.content.includes("`src/comp0.ts`"));
  } finally {
    cleanup(base);
  }
});

test("generateCodebaseMap: truncated=false when file count is below maxFiles", () => {
  const base = makeTmpRepo();
  try {
    for (let i = 0; i < 4; i++) addFile(base, `file${i}.ts`);
    const result = generateCodebaseMap(base, { maxFiles: 5 });
    assert.equal(result.fileCount, 4);
    assert.equal(result.truncated, false);
  } finally {
    cleanup(base);
  }
});

test("generateCodebaseMap: truncated=false when file count equals maxFiles exactly", () => {
  const base = makeTmpRepo();
  try {
    for (let i = 0; i < 5; i++) addFile(base, `file${i}.ts`);
    const result = generateCodebaseMap(base, { maxFiles: 5 });
    assert.equal(result.fileCount, 5);
    assert.equal(result.truncated, false); // exactly at limit — nothing was truncated
  } finally {
    cleanup(base);
  }
});

test("generateCodebaseMap: truncated=true when file count exceeds maxFiles", () => {
  const base = makeTmpRepo();
  try {
    for (let i = 0; i < 10; i++) addFile(base, `file${i}.ts`);
    const result = generateCodebaseMap(base, { maxFiles: 5 });
    assert.equal(result.fileCount, 5);
    assert.equal(result.truncated, true);
    assert.ok(result.content.includes("Truncated"));
  } finally {
    cleanup(base);
  }
});

test("generateCodebaseMap: returns empty map for non-git directory", () => {
  const base = join(tmpdir(), `gsd-codebase-test-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  // No git init
  try {
    const result = generateCodebaseMap(base);
    assert.equal(result.fileCount, 0);
    assert.equal(result.truncated, false);
    assert.ok(result.content.includes("# Codebase Map"));
    assert.equal(result.files.length, 0);
  } finally {
    cleanup(base);
  }
});

test("generateCodebaseMap: handles empty repository (no committed files)", () => {
  const base = makeTmpRepo();
  try {
    const result = generateCodebaseMap(base);
    assert.equal(result.fileCount, 0);
    assert.equal(result.truncated, false);
    assert.ok(result.content.includes("Files: 0"));
  } finally {
    cleanup(base);
  }
});

test("generateCodebaseMap: collapsed directories preserve descriptions in hidden comment", () => {
  const base = makeTmpRepo();
  try {
    for (let i = 0; i < 25; i++) {
      addFile(base, `src/components/comp${String(i).padStart(2, "0")}.ts`);
    }

    // Generate with a description for one file in the collapsed dir
    const descriptions = new Map([["src/components/comp00.ts", "The first component"]]);
    const result = generateCodebaseMap(base, undefined, descriptions);

    // The description should be in the hidden comment block
    assert.ok(result.content.includes("<!-- gsd:collapsed-descriptions"));
    assert.ok(result.content.includes("`src/components/comp00.ts` — The first component"));

    // Re-parsing should recover the description
    const recovered = parseCodebaseMap(result.content);
    assert.equal(recovered.get("src/components/comp00.ts"), "The first component");
  } finally {
    cleanup(base);
  }
});

// ─── updateCodebaseMap ───────────────────────────────────────────────────

test("updateCodebaseMap: preserves descriptions on update", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    addFile(base, "src/utils.ts");

    const initial = generateCodebaseMap(base, undefined, new Map([["src/main.ts", "Entry point"]]));
    writeCodebaseMap(base, initial.content);

    addFile(base, "src/new.ts");

    const result = updateCodebaseMap(base);
    assert.ok(result.content.includes("`src/main.ts` — Entry point"));
    assert.equal(result.added, 1);
    assert.equal(result.fileCount, 3);
  } finally {
    cleanup(base);
  }
});

test("updateCodebaseMap: tracks removed files", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/keep.ts");
    addFile(base, "src/remove.ts");
    // Commit so git rm can operate
    execSync("git -c user.email=t@t.com -c user.name=T commit -m init", { cwd: base, stdio: "ignore" });

    const initial = generateCodebaseMap(base);
    writeCodebaseMap(base, initial.content);

    execSync("git rm src/remove.ts", { cwd: base, stdio: "ignore" });

    const result = updateCodebaseMap(base);
    assert.equal(result.removed, 1);
    assert.equal(result.unchanged, 1);
    assert.equal(result.fileCount, 1);
    assert.ok(!result.content.includes("remove.ts"));
  } finally {
    cleanup(base);
  }
});

test("updateCodebaseMap: propagates truncated flag", () => {
  const base = makeTmpRepo();
  try {
    for (let i = 0; i < 10; i++) addFile(base, `file${i}.ts`);

    const initial = generateCodebaseMap(base, { maxFiles: 5 });
    writeCodebaseMap(base, initial.content);

    const result = updateCodebaseMap(base, { maxFiles: 5 });
    assert.equal(result.truncated, true);
  } finally {
    cleanup(base);
  }
});

test("updateCodebaseMap: preserves descriptions from collapsed directories", () => {
  const base = makeTmpRepo();
  try {
    for (let i = 0; i < 25; i++) {
      addFile(base, `src/components/comp${String(i).padStart(2, "0")}.ts`);
    }

    // Generate with a description in the (collapsed) components dir
    const descriptions = new Map([["src/components/comp00.ts", "The first component"]]);
    const initial = generateCodebaseMap(base, undefined, descriptions);
    writeCodebaseMap(base, initial.content);

    // Update should recover description from the hidden comment
    const result = updateCodebaseMap(base);
    const recovered = parseCodebaseMap(result.content);
    assert.equal(recovered.get("src/components/comp00.ts"), "The first component");
  } finally {
    cleanup(base);
  }
});

// ─── writeCodebaseMap / readCodebaseMap ──────────────────────────────────

test("writeCodebaseMap + readCodebaseMap roundtrip", () => {
  const base = makeTmpRepo();
  try {
    const content = "# Codebase Map\n\n- `test.ts` — A test file\n";
    const outPath = writeCodebaseMap(base, content);
    assert.ok(existsSync(outPath));

    const read = readCodebaseMap(base);
    assert.equal(read, content);
  } finally {
    cleanup(base);
  }
});

test("readCodebaseMap: returns null when file missing", () => {
  const base = makeTmpRepo();
  try {
    const result = readCodebaseMap(base);
    assert.equal(result, null);
  } finally {
    cleanup(base);
  }
});

test("writeCodebaseMap: creates .gsd/ directory if missing", () => {
  const base = join(tmpdir(), `gsd-codebase-test-${randomUUID()}`);
  mkdirSync(base, { recursive: true });
  // Intentionally do NOT pre-create .gsd/
  try {
    const outPath = writeCodebaseMap(base, "# Codebase Map\n");
    assert.ok(existsSync(outPath));
  } finally {
    cleanup(base);
  }
});

// ─── getCodebaseMapStats ─────────────────────────────────────────────────

test("getCodebaseMapStats: no map returns exists=false", () => {
  const base = makeTmpRepo();
  try {
    const stats = getCodebaseMapStats(base);
    assert.equal(stats.exists, false);
    assert.equal(stats.fileCount, 0);
  } finally {
    cleanup(base);
  }
});

test("getCodebaseMapStats: reports coverage", () => {
  const base = makeTmpRepo();
  try {
    const content = `# Codebase Map\n\nGenerated: 2026-03-23T14:00:00Z | Files: 3 | Described: 2/3\n\n- \`a.ts\` — Has desc\n- \`b.ts\`\n- \`c.ts\` — Also has\n`;
    writeCodebaseMap(base, content);

    const stats = getCodebaseMapStats(base);
    assert.equal(stats.exists, true);
    assert.equal(stats.fileCount, 3); // from header, not parse count
    assert.equal(stats.describedCount, 2);
    assert.equal(stats.undescribedCount, 1);
    assert.equal(stats.generatedAt, "2026-03-23T14:00:00Z");
  } finally {
    cleanup(base);
  }
});

test("getCodebaseMapStats: reads total file count from header for accuracy with collapsed dirs", () => {
  const base = makeTmpRepo();
  try {
    // Simulate a map with a collapsed dir: header says 30 files but parser only sees 2
    const content = [
      "# Codebase Map",
      "",
      "Generated: 2026-03-23T14:00:00Z | Files: 30 | Described: 2/30",
      "",
      "### src/components/",
      "- *(28 files: 28 .ts)*",
      "",
      "### src/",
      "- `main.ts` — Entry point",
      "- `utils.ts` — Utilities",
    ].join("\n");
    writeCodebaseMap(base, content);

    const stats = getCodebaseMapStats(base);
    assert.equal(stats.fileCount, 30); // from header, not from parseCodebaseMap
    assert.equal(stats.describedCount, 2);
    assert.equal(stats.undescribedCount, 28);
  } finally {
    cleanup(base);
  }
});

// ─── excludePatterns from options ────────────────────────────────────────

test("generateCodebaseMap: custom excludePatterns filters additional directories", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    addFile(base, "src/utils.ts");
    addFile(base, ".cache-data/data/index.lance");
    addFile(base, "docs/guide.md");

    const result = generateCodebaseMap(base, {
      excludePatterns: [".cache-data/", "docs/"],
    });
    assert.ok(result.content.includes("`src/main.ts`"));
    assert.ok(result.content.includes("`src/utils.ts`"));
    assert.ok(!result.content.includes(".cache-data"));
    assert.ok(!result.content.includes("guide.md"));
    assert.equal(result.fileCount, 2);
  } finally {
    cleanup(base);
  }
});

test("generateCodebaseMap: collapseThreshold option overrides default", () => {
  const base = makeTmpRepo();
  try {
    // Create 10 files in one directory — below default threshold (20)
    // but above a custom threshold of 5
    for (let i = 0; i < 10; i++) {
      addFile(base, `src/comp${i}.ts`);
    }

    // With default threshold (20), files should NOT collapse
    const expanded = generateCodebaseMap(base);
    assert.ok(expanded.content.includes("`src/comp0.ts`"));

    // With custom threshold (5), files SHOULD collapse
    const collapsed = generateCodebaseMap(base, { collapseThreshold: 5 });
    assert.ok(collapsed.content.includes("10 files"));
    assert.ok(!collapsed.content.includes("`src/comp0.ts`\n"));
  } finally {
    cleanup(base);
  }
});

test("updateCodebaseMap: respects excludePatterns option", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    addFile(base, "vendor-extra/lib.js");

    const initial = generateCodebaseMap(base);
    writeCodebaseMap(base, initial.content);

    // Update with exclusion should remove vendor-extra files
    const result = updateCodebaseMap(base, { excludePatterns: ["vendor-extra/"] });
    assert.ok(result.content.includes("`src/main.ts`"));
    assert.ok(!result.content.includes("vendor-extra"));
  } finally {
    cleanup(base);
  }
});

test("ensureCodebaseMapFresh: generates CODEBASE.md when missing", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");

    const result = ensureCodebaseMapFresh(base, undefined, { ttlMs: 0, force: true });
    const written = readCodebaseMap(base);

    assert.equal(result.status, "generated");
    assert.ok(written?.includes("`src/main.ts`"));
  } finally {
    cleanup(base);
  }
});

test("ensureCodebaseMapFresh: updates CODEBASE.md when tracked files change", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    const initial = ensureCodebaseMapFresh(base, undefined, { ttlMs: 0, force: true });
    assert.equal(initial.status, "generated");

    addFile(base, "src/new.ts");
    const refreshed = ensureCodebaseMapFresh(base, undefined, { ttlMs: 0, force: true });
    const written = readCodebaseMap(base);

    assert.equal(refreshed.status, "updated");
    assert.equal(refreshed.reason, "files-changed");
    assert.ok(written?.includes("`src/new.ts`"));
  } finally {
    cleanup(base);
  }
});

test("ensureCodebaseMapFresh: returns fresh when metadata matches repository state", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    ensureCodebaseMapFresh(base, undefined, { ttlMs: 0, force: true });

    const refreshed = ensureCodebaseMapFresh(base, undefined, { ttlMs: 0, force: true });
    assert.equal(refreshed.status, "fresh");
    assert.equal(refreshed.fileCount, 1);
  } finally {
    cleanup(base);
  }
});

test("ensureCodebaseMapFresh: does not rewrite expired metadata when fingerprint is unchanged", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    ensureCodebaseMapFresh(base, undefined, { ttlMs: 0, force: true });

    const staleGeneratedAt = "2026-01-01T00:00:00Z";
    const original = readCodebaseMap(base);
    assert.ok(original);
    const staleContent = original
      .replace(/Generated: \S+/, `Generated: ${staleGeneratedAt}`)
      .replace(/"generatedAt":"[^"]+"/, `"generatedAt":"${staleGeneratedAt}"`);
    writeCodebaseMap(base, staleContent);

    const refreshed = ensureCodebaseMapFresh(base, undefined, {
      ttlMs: 0,
      maxAgeMs: 1,
      force: true,
    });
    const written = readCodebaseMap(base);

    assert.equal(refreshed.status, "fresh");
    assert.equal(refreshed.generatedAt, staleGeneratedAt);
    assert.equal(written, staleContent);
  } finally {
    cleanup(base);
  }
});

test("ensureCodebaseMapFresh: uses TTL cache before enumerating files", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    const initial = ensureCodebaseMapFresh(base, undefined, { ttlMs: 60_000 });
    assert.equal(initial.status, "generated");

    const emptyBin = join(base, "empty-bin");
    mkdirSync(emptyBin);
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = emptyBin;

      const cached = ensureCodebaseMapFresh(base, undefined, { ttlMs: 60_000 });
      assert.equal(cached.status, "generated");
      assert.equal(cached.fingerprint, initial.fingerprint);
      assert.equal(cached.fileCount, 1);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  } finally {
    cleanup(base);
  }
});

// ─── Workspace-aware (parent mode) ───────────────────────────────────────

/**
 * Build a parent workspace: a parent git repo whose .gsd/PREFERENCES.md declares
 * child repositories, each child being its own separate git repo nested inside.
 */
function makeTmpParentWorkspace(children: string[]): string {
  const base = join(tmpdir(), `gsd-codebase-parent-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  execSync("git init", { cwd: base, stdio: "ignore" });

  const repoLines = children.map((id) => `    ${id}:\n      path: ${id}`).join("\n");
  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    `---\nversion: 1\nworkspace:\n  mode: parent\n  repositories:\n${repoLines}\n---\n`,
    "utf-8",
  );

  for (const child of children) {
    const childPath = join(base, child);
    mkdirSync(childPath, { recursive: true });
    execSync("git init", { cwd: childPath, stdio: "ignore" });
  }
  return base;
}

function addChildFile(base: string, child: string, path: string, content = ""): void {
  const childRoot = join(base, child);
  const fullPath = join(childRoot, path);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content || `// ${child}/${path}\n`, "utf-8");
  execSync(`git add "${path}"`, { cwd: childRoot, stdio: "ignore" });
}

test("workspace-aware: parent mode enumerates each declared child repo under a repo heading", () => {
  const base = makeTmpParentWorkspace(["frontend", "backend"]);
  try {
    addChildFile(base, "frontend", "src/App.tsx");
    addChildFile(base, "backend", "src/server.ts");

    const result = generateCodebaseMap(base);

    // Both repos appear as labelled sections.
    assert.match(result.content, /## \[frontend\]/);
    assert.match(result.content, /## \[backend\]/);
    // Child files are rewritten to workspace-relative paths.
    assert.match(result.content, /`frontend\/src\/App\.tsx`/);
    assert.match(result.content, /`backend\/src\/server\.ts`/);
    assert.equal(result.fileCount, 2);
  } finally {
    cleanup(base);
  }
});

test("workspace-aware: metadata records the repositories whose files appear in the map", () => {
  const base = makeTmpParentWorkspace(["frontend", "backend"]);
  try {
    addChildFile(base, "frontend", "src/App.tsx");
    addChildFile(base, "backend", "src/server.ts");

    const result = generateCodebaseMap(base);
    const metadata = parseCodebaseMapMetadata(result.content);

    assert.ok(metadata, "metadata should be present");
    assert.deepEqual(metadata?.repositories?.sort(), ["backend", "frontend"]);
  } finally {
    cleanup(base);
  }
});

test("workspace-aware: parseCodebaseMap recovers descriptions across repo sections", () => {
  const base = makeTmpParentWorkspace(["frontend", "backend"]);
  try {
    addChildFile(base, "frontend", "src/App.tsx");
    addChildFile(base, "backend", "src/server.ts");

    // Seed descriptions keyed by the workspace-relative paths.
    const descriptions = new Map<string, string>([
      ["frontend/src/App.tsx", "React entry"],
      ["backend/src/server.ts", "Express API"],
    ]);
    const result = generateCodebaseMap(base, undefined, descriptions);
    writeCodebaseMap(base, result.content);

    const parsed = parseCodebaseMap(readCodebaseMap(base)!);
    assert.equal(parsed.get("frontend/src/App.tsx"), "React entry");
    assert.equal(parsed.get("backend/src/server.ts"), "Express API");
  } finally {
    cleanup(base);
  }
});

test("workspace-aware: project mode (no declared children) stays single-section", () => {
  // A plain single repo with no workspace config must render exactly as before.
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");

    const result = generateCodebaseMap(base);

    assert.doesNotMatch(result.content, /## \[/);
    assert.match(result.content, /`src\/main\.ts`/);
    const metadata = parseCodebaseMapMetadata(result.content);
    assert.equal(metadata?.repositories, undefined);
  } finally {
    cleanup(base);
  }
});

test("workspace-aware: updateCodebaseMap tracks child-repo file additions", () => {
  const base = makeTmpParentWorkspace(["frontend"]);
  try {
    addChildFile(base, "frontend", "src/App.tsx");
    const first = updateCodebaseMap(base);
    writeCodebaseMap(base, first.content);
    assert.equal(first.added, 1);

    addChildFile(base, "frontend", "src/index.tsx");
    const second = updateCodebaseMap(base);
    assert.equal(second.added, 1);
    assert.equal(second.removed, 0);
    assert.equal(second.fileCount, 2);
  } finally {
    cleanup(base);
  }
});

test("workspace-aware: workspace-relative exclude patterns filter child-repo files", () => {
  // Regression guard: exclude patterns like `frontend/` are workspace-relative,
  // so they must be matched against the rewritten path, not the child-relative one.
  const base = makeTmpParentWorkspace(["frontend", "backend"]);
  try {
    addChildFile(base, "frontend", "src/App.tsx");
    addChildFile(base, "backend", "src/server.ts");

    const result = generateCodebaseMap(base, { excludePatterns: ["frontend/"] });

    assert.doesNotMatch(result.content, /frontend\/src\/App\.tsx/);
    assert.match(result.content, /backend\/src\/server\.ts/);
    assert.equal(result.fileCount, 1);
  } finally {
    cleanup(base);
  }
});

test("workspace-aware: maxFiles cap does not starve child repos for the project repo", () => {
  // The implicit project repo is enumerated alongside children; the cap must be
  // applied fairly (round-robin) so a large project repo cannot crowd out children.
  const base = makeTmpParentWorkspace(["frontend", "backend"]);
  try {
    addChildFile(base, "frontend", "a.ts");
    addChildFile(base, "frontend", "b.ts");
    addChildFile(base, "backend", "c.ts");

    // Cap at 2 files — with fair distribution both repos should appear.
    const result = generateCodebaseMap(base, { maxFiles: 2 });
    const repoSections = (result.content.match(/^## \[.+\]/gm) ?? []).length;

    assert.equal(result.fileCount, 2);
    assert.ok(repoSections >= 2, "both child repos should be represented under a tight cap");
  } finally {
    cleanup(base);
  }
});

test("workspace-aware: overlapping paths dedupe without falsely reporting truncation", () => {
  // Regression guard: a path tracked by both the implicit project repo and a child
  // repo collapses to one workspace-relative entry. Deduplicated duplicates must not
  // count toward the maxFiles cap, so the map must not be flagged as truncated.
  const base = join(tmpdir(), `gsd-codebase-parent-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  execSync("git init", { cwd: base, stdio: "ignore" });
  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    `---\nversion: 1\nworkspace:\n  mode: parent\n  repositories:\n    lib:\n      path: lib\n---\n`,
    "utf-8",
  );
  try {
    // The project repo tracks lib/util.ts before lib becomes its own repo; the child
    // repo then tracks util.ts, so both resolve to the same workspace path lib/util.ts.
    addFile(base, "lib/util.ts");
    execSync("git init", { cwd: join(base, "lib"), stdio: "ignore" });
    execSync("git add util.ts", { cwd: join(base, "lib"), stdio: "ignore" });

    const result = generateCodebaseMap(base);

    assert.equal(result.fileCount, 1);
    assert.equal(result.truncated, false);
    assert.equal((result.content.match(/`lib\/util\.ts`/g) ?? []).length, 1);
  } finally {
    cleanup(base);
  }
});

test("workspace-aware: project directories interleaving child prefixes stay under one heading", () => {
  // Regression guard: the implicit project repo has an empty prefix, so its
  // root-level dirs (aaa/, zzz/) sort lexically around a child prefix (mmm/).
  // Groups must be ordered per repo so `## [project]` is emitted exactly once.
  const base = makeTmpParentWorkspace(["mmm"]);
  try {
    addFile(base, "aaa/x.ts"); // project repo, sorts before "mmm"
    addFile(base, "zzz/y.ts"); // project repo, sorts after "mmm"
    addChildFile(base, "mmm", "src/thing.ts");

    const result = generateCodebaseMap(base);

    const projectHeadings = (result.content.match(/^## \[project\]$/gm) ?? []).length;
    const mmmHeadings = (result.content.match(/^## \[mmm\]$/gm) ?? []).length;
    const allHeadings = (result.content.match(/^## \[.+\]$/gm) ?? []).length;

    assert.equal(projectHeadings, 1, "project section must not be split across headings");
    assert.equal(mmmHeadings, 1);
    assert.equal(allHeadings, 2);
  } finally {
    cleanup(base);
  }
});

test("workspace-aware: renaming a declared repo id invalidates map freshness", () => {
  // Regression guard: repo identity is rendered into the map, so renaming a repo id
  // (path unchanged → identical file paths) must be caught by the freshness
  // fingerprint rather than leaving a stale `## [old-id]` heading in place.
  const base = makeTmpParentWorkspace(["frontend"]);
  try {
    addChildFile(base, "frontend", "src/App.tsx");

    ensureCodebaseMapFresh(base, undefined, { ttlMs: 0, force: true });
    assert.match(readCodebaseMap(base)!, /^## \[frontend\]$/m);

    // Rename the repo id to `web`; the path (and therefore the file paths) is unchanged.
    writeFileSync(
      join(base, ".gsd", "PREFERENCES.md"),
      `---\nversion: 1\nworkspace:\n  mode: parent\n  repositories:\n    web:\n      path: frontend\n---\n`,
      "utf-8",
    );

    const refreshed = ensureCodebaseMapFresh(base, undefined, { ttlMs: 0, force: true });
    const written = readCodebaseMap(base)!;

    assert.equal(refreshed.status, "updated");
    assert.match(written, /^## \[web\]$/m);
    assert.doesNotMatch(written, /^## \[frontend\]$/m);
    assert.deepEqual(parseCodebaseMapMetadata(written)?.repositories, ["web"]);
  } finally {
    cleanup(base);
  }
});

test("single-repo: directory order stays byte-identical code-unit sort (not locale-aware)", () => {
  // Byte-identical single-repo invariant: pre-workspace output ordered
  // directories with a bare `.sort()` (UTF-16 code-unit order), so uppercase
  // sorts before lowercase ("Zoo" < "apple"). A locale-aware comparator inverts
  // these and silently changes project-mode CODEBASE.md, so guard the ordering.
  const base = makeTmpRepo();
  try {
    addFile(base, "Zoo/keeper.ts"); // 'Z' (0x5A) < 'a' (0x61) → sorts first
    addFile(base, "apple/tree.ts");

    const content = generateCodebaseMap(base).content;
    const zooIdx = content.indexOf("### Zoo/");
    const appleIdx = content.indexOf("### apple/");

    assert.notEqual(zooIdx, -1);
    assert.notEqual(appleIdx, -1);
    assert.ok(zooIdx < appleIdx, "code-unit order must place Zoo/ before apple/");
    // Project mode emits no repo partition heading.
    assert.doesNotMatch(content, /^## \[.+\]$/m);
  } finally {
    cleanup(base);
  }
});

test("workspace-aware: an invalid workspace registry surfaces an error instead of silently falling back", () => {
  // Regression guard: a broken parent-mode config (here a child path escaping the
  // project root) must propagate as an error. Swallowing it and falling back to a
  // single-root map would silently drop every child repo from planning context.
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    writeFileSync(
      join(base, ".gsd", "PREFERENCES.md"),
      `---\nversion: 1\nworkspace:\n  mode: parent\n  repositories:\n    frontend:\n      path: ../escapes-root\n---\n`,
      "utf-8",
    );

    assert.throws(() => generateCodebaseMap(base), /resolves outside project root/);
  } finally {
    cleanup(base);
  }
});

test("workspace-aware: files sharing a directory across repos keep their own repo heading", () => {
  // Regression guard: the implicit project repo and a child repo can own different
  // files under the same workspace-relative directory (lib/). Groups are keyed by
  // (repo, dir), so each file must render under its own `## [repo-id]` heading
  // instead of collapsing into one section labelled with a single (wrong) repo.
  const base = join(tmpdir(), `gsd-codebase-parent-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  execSync("git init", { cwd: base, stdio: "ignore" });
  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    `---\nversion: 1\nworkspace:\n  mode: parent\n  repositories:\n    lib:\n      path: lib\n---\n`,
    "utf-8",
  );
  try {
    // Project repo tracks lib/app.ts before lib becomes its own repo; the child
    // repo then tracks helper.ts → workspace path lib/helper.ts. Different files,
    // same directory, different repos.
    addFile(base, "lib/app.ts");
    execSync("git init", { cwd: join(base, "lib"), stdio: "ignore" });
    writeFileSync(join(base, "lib", "helper.ts"), "// helper\n", "utf-8");
    execSync("git add helper.ts", { cwd: join(base, "lib"), stdio: "ignore" });

    const content = generateCodebaseMap(base).content;

    // Both files present, each under its own repo section (not merged under one).
    assert.match(content, /## \[project\]/);
    assert.match(content, /## \[lib\]/);
    const projectIdx = content.indexOf("## [project]");
    const appIdx = content.indexOf("`lib/app.ts`");
    const libIdx = content.indexOf("## [lib]");
    const helperIdx = content.indexOf("`lib/helper.ts`");
    assert.ok(
      projectIdx < appIdx && appIdx < libIdx && libIdx < helperIdx,
      "lib/app.ts must sit under [project] and lib/helper.ts under [lib]",
    );
  } finally {
    cleanup(base);
  }
});

test("ensureCodebaseMapFresh: editing declared repos within the TTL window bypasses the cache", () => {
  // Regression guard: the freshness TTL cache key folds in the workspace signature
  // (mode + declared repos). Adding a child repo must miss the cache and re-enumerate
  // rather than serve a stale map that omits the new repo until the TTL expires.
  const base = makeTmpParentWorkspace(["frontend"]);
  try {
    addChildFile(base, "frontend", "src/App.tsx");

    const initial = ensureCodebaseMapFresh(base, undefined, { ttlMs: 60_000 });
    assert.equal(initial.status, "generated");
    assert.doesNotMatch(readCodebaseMap(base)!, /## \[backend\]/);

    // Declare a second child repo and back it with a real nested repo + file.
    mkdirSync(join(base, "backend"), { recursive: true });
    execSync("git init", { cwd: join(base, "backend"), stdio: "ignore" });
    addChildFile(base, "backend", "src/server.ts");
    writeFileSync(
      join(base, ".gsd", "PREFERENCES.md"),
      `---\nversion: 1\nworkspace:\n  mode: parent\n  repositories:\n    frontend:\n      path: frontend\n    backend:\n      path: backend\n---\n`,
      "utf-8",
    );

    // Same TTL window, no force: the changed workspace signature must miss the cache.
    const refreshed = ensureCodebaseMapFresh(base, undefined, { ttlMs: 60_000 });
    const written = readCodebaseMap(base)!;

    assert.equal(refreshed.status, "updated");
    assert.match(written, /## \[backend\]/);
    assert.match(written, /`backend\/src\/server\.ts`/);
  } finally {
    cleanup(base);
  }
});
