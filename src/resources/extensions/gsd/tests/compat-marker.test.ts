// Project/App: gsd-pi
// File Purpose: Unit tests for the gsd-core compat marker (`.gsd/.compat.json`).
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  readCompatMarker,
  writeCompatMarker,
  normalizeForHash,
  computeProjectionSha,
  EMPTY_MARKER,
  compatMarkerPath,
} from "../compat/compat-marker.ts";

const tmpDirs: string[] = [];

function makeTmpBase(): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-compat-${randomUUID()}`));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  tmpDirs.push(base);
  return base;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
  tmpDirs.length = 0;
});

test("readCompatMarker returns EMPTY_MARKER when file is missing", () => {
  const base = makeTmpBase();
  const marker = readCompatMarker(base);
  assert.deepEqual(marker, EMPTY_MARKER);
});

test("writeCompatMarker then readCompatMarker round-trips", () => {
  const base = makeTmpBase();
  const marker = {
    schema: 2,
    lastWriter: "gsd-pi" as const,
    lastProjectedAt: "2026-06-21T00:00:00.000Z",
    projections: {
      "roadmap.md": { sha: "abc123", entities: ["m1"] },
    },
    planning: { active: false, layout: null, projections: {}, passthrough: {} },
    piVersion: "1.4.0",
  };
  writeCompatMarker(base, marker);
  const read = readCompatMarker(base);
  assert.deepEqual(read, marker);
});

test("readCompatMarker quarantines malformed JSON and returns EMPTY_MARKER", () => {
  const base = makeTmpBase();
  writeFileSync(compatMarkerPath(base), "{ not valid json", "utf-8");
  const marker = readCompatMarker(base);
  assert.deepEqual(marker, EMPTY_MARKER);
  const files = readdirSync(join(base, ".gsd"));
  // Quarantine backup should exist.
  const quarantined = files.some((f: string) => f.startsWith(".compat.json.bad-"));
  assert.ok(quarantined, "expected a quarantined .compat.json.bad-* file");
  // Original should be gone — the quarantine fix removes it so repeated reads
  // don't accumulate unbounded .bad-* files.
  assert.ok(!files.includes(".compat.json"), "corrupt original should be deleted after quarantine");
});

test("quarantine does not grow unbounded .bad-* files on repeated reads", () => {
  const base = makeTmpBase();
  writeFileSync(compatMarkerPath(base), "not valid json at all", "utf-8");

  // First read quarantines and removes the original.
  readCompatMarker(base);
  const filesAfterFirst = readdirSync(join(base, ".gsd"));
  const badCountAfterFirst = filesAfterFirst.filter((f: string) => f.startsWith(".compat.json.bad-")).length;
  assert.equal(badCountAfterFirst, 1, "expected exactly one .bad-* file after first read");
  assert.ok(!filesAfterFirst.includes(".compat.json"), "corrupt original should be gone after first read");

  // Second read sees no file → EMPTY_MARKER fast path, no new .bad-* created.
  readCompatMarker(base);
  const filesAfterSecond = readdirSync(join(base, ".gsd"));
  const badCountAfterSecond = filesAfterSecond.filter((f: string) => f.startsWith(".compat.json.bad-")).length;
  assert.equal(badCountAfterSecond, 1, "second read must not create an additional .bad-* file");
});

test("normalizeForHash trims trailing whitespace and converts CRLF to LF", () => {
  const input = "line one  \r\nline two\r\n";
  const out = normalizeForHash(input);
  assert.equal(out, "line one\nline two\n");
});

test("computeProjectionSha is stable for cosmetically different but equivalent content", () => {
  const a = computeProjectionSha("hello\r\nworld  \n");
  const b = computeProjectionSha("hello\nworld\n");
  assert.equal(a, b);
});

test("compatMarkerPath resolves under .gsd", () => {
  const base = makeTmpBase();
  assert.equal(compatMarkerPath(base), join(base, ".gsd", ".compat.json"));
});
