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
  pruneOrphanedProjectionEntries,
  EMPTY_MARKER,
  compatMarkerPath,
} from "../compat/compat-marker.ts";
import { externalMarkdownEditHandler } from "../state-reconciliation/drift/external-markdown-edit.ts";
import type { DriftContext } from "../state-reconciliation/types.ts";
import type { GSDState } from "../types.ts";

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

test("pruneOrphanedProjectionEntries drops entries whose backing file is gone (#1257)", () => {
  const base = makeTmpBase();
  // Live projection: file exists on disk.
  const liveRel = "phases/29-frontend-code-debt-cleanup/29-ROADMAP.md";
  mkdirSync(join(base, ".gsd", "phases", "29-frontend-code-debt-cleanup"), { recursive: true });
  writeFileSync(join(base, ".gsd", liveRel), "# M029\n", "utf-8");
  // Phantom projection: directory was renamed, file no longer exists.
  const ghostRel = "phases/29-new-milestone-m029/29-ROADMAP.md";

  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-07-05T05:35:19.379Z",
    projections: {
      [liveRel]: { sha: "live000000000000", entities: ["M029"] },
      [ghostRel]: { sha: "ghost00000000000", entities: ["M029"] },
    },
    piVersion: "1.4.0",
  });

  const removed = pruneOrphanedProjectionEntries(base);
  assert.equal(removed, 1);

  const marker = readCompatMarker(base);
  assert.ok(marker.projections[liveRel], "live projection must survive");
  assert.equal(marker.projections[ghostRel], undefined, "phantom projection must be pruned");
});

test("pruneOrphanedProjectionEntries also prunes .planning projections/passthrough", () => {
  const base = makeTmpBase();
  mkdirSync(join(base, ".planning"), { recursive: true });
  writeFileSync(join(base, ".planning", "ROADMAP.md"), "# roadmap\n", "utf-8");

  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-07-05T05:35:19.379Z",
    projections: {},
    planning: {
      active: true,
      layout: "flat-phases",
      projections: {
        "ROADMAP.md": { sha: "live000000000000", entities: [] },
        "gone/PLAN.md": { sha: "ghost00000000000", entities: [] },
      },
      passthrough: {
        "gone/PATTERNS.md": { sha: "ghost11111111111", entities: [] },
      },
    },
    piVersion: "1.4.0",
  });

  const removed = pruneOrphanedProjectionEntries(base);
  assert.equal(removed, 2);

  const marker = readCompatMarker(base);
  assert.ok(marker.planning!.projections["ROADMAP.md"], "live planning projection must survive");
  assert.equal(marker.planning!.projections["gone/PLAN.md"], undefined);
  assert.equal(marker.planning!.passthrough["gone/PATTERNS.md"], undefined);
});

test("pruneOrphanedProjectionEntries is a no-op when nothing is orphaned", () => {
  const base = makeTmpBase();
  const rel = "phases/01-phase/01-01-PLAN.md";
  mkdirSync(join(base, ".gsd", "phases", "01-phase"), { recursive: true });
  writeFileSync(join(base, ".gsd", rel), "# plan\n", "utf-8");
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-07-05T05:35:19.379Z",
    projections: { [rel]: { sha: "abc000000000000", entities: ["M001"] } },
    piVersion: "1.4.0",
  });

  assert.equal(pruneOrphanedProjectionEntries(base), 0);
});

test("pruneOrphanedProjectionEntries returns 0 and writes nothing when marker is missing", () => {
  const base = makeTmpBase();
  assert.equal(pruneOrphanedProjectionEntries(base), 0);
  const files = readdirSync(join(base, ".gsd"));
  assert.ok(!files.includes(".compat.json"), "must not create a marker where none existed");
});

// --- Path-traversal containment (plan 029) ---------------------------------
//
// The marker is repo-controlled content whose projection-map keys are joined
// with basePath and readFileSync'd by the drift detectors. A key that escapes
// .gsd/ must invalidate the whole marker so readCompatMarker fails safe to the
// empty marker (detectors see no entries → nothing outside the repo is read).

for (const badKey of ["../outside.md", "/etc/hosts", "C:/x.md", "..\\x.md"]) {
  test(`readCompatMarker rejects a projection key that escapes the root: ${JSON.stringify(badKey)}`, () => {
    const base = makeTmpBase();
    // Write the hostile marker directly (writeCompatMarker does not validate).
    writeCompatMarker(base, {
      schema: 2,
      lastWriter: "gsd-pi",
      lastProjectedAt: "2026-07-07T00:00:00.000Z",
      projections: { [badKey]: { sha: "deadbeefdeadbeef", entities: ["m1"] } },
      piVersion: "1.8.1",
    });

    const marker = readCompatMarker(base);
    assert.equal(
      Object.keys(marker.projections).length,
      0,
      "a marker with an escaping key must fall back to the empty marker",
    );
  });
}

test("readCompatMarker preserves legitimate nested projection keys", () => {
  const base = makeTmpBase();
  const roadmap = "milestones/M001/M001-ROADMAP.md";
  const context = "phases/01-foo/01-CONTEXT.md";
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-07-07T00:00:00.000Z",
    projections: {
      [roadmap]: { sha: "aaaaaaaaaaaaaaaa", entities: ["M001"] },
      [context]: { sha: "bbbbbbbbbbbbbbbb", entities: ["P01"] },
    },
    planning: { active: false, layout: null, projections: {}, passthrough: {} },
    piVersion: "1.8.1",
  });

  const marker = readCompatMarker(base);
  assert.ok(marker.projections[roadmap], "roadmap key must round-trip");
  assert.ok(marker.projections[context], "nested phase key must round-trip");
  assert.equal(Object.keys(marker.projections).length, 2);
});

test("an escaping key in planning.passthrough also invalidates the whole marker", () => {
  const base = makeTmpBase();
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-07-07T00:00:00.000Z",
    projections: {},
    planning: {
      active: true,
      layout: "flat-phases",
      projections: {},
      passthrough: { "../../secret.md": { sha: "cccccccccccccccc", entities: [] } },
    },
    piVersion: "1.8.1",
  });

  const marker = readCompatMarker(base);
  assert.equal(Object.keys(marker.projections).length, 0);
  assert.equal(marker.planning!.active, false, "planning falls back to inactive default");
});

test("hostile marker makes the drift detector read nothing outside the project", async () => {
  const base = makeTmpBase();
  // Sentinel lives OUTSIDE the project dir; a `../` traversal from .gsd/ would
  // reach it if the key were trusted.
  const sentinelDir = mkdtempSync(join(tmpdir(), `gsd-sentinel-${randomUUID()}`));
  tmpDirs.push(sentinelDir);
  const sentinelName = "known_hosts";
  writeFileSync(join(sentinelDir, sentinelName), "SECRET\n", "utf-8");
  const escapeKey = `../../${sentinelName}`; // e.g. ../../known_hosts

  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-07-07T00:00:00.000Z",
    projections: { [escapeKey]: { sha: "0000000000000000", entities: ["m1"] } },
    piVersion: "1.8.1",
  });

  const stubState = { phase: "idle" } as unknown as GSDState;
  const ctx: DriftContext = { basePath: base, state: stubState };

  // Must not throw and must not emit a record referencing the sentinel.
  const drift = await externalMarkdownEditHandler.detect(stubState, ctx);
  assert.equal(drift.length, 0, "no drift record from a rejected hostile marker");
  assert.ok(
    !drift.some((d) => d.projectionPath.includes(sentinelName)),
    "detector must not reference the out-of-project sentinel",
  );
});
