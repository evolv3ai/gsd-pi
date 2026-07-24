// Project/App: gsd-pi
// File Purpose: Proves /gsd sync fails closed on modeled projection drift.

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";

import { handleSync } from "../commands-maintenance.ts";
import {
  computeProjectionSha,
  readCompatMarker,
  writeCompatMarker,
} from "../compat/compat-marker.ts";
import {
  _getAdapter,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  isDbAvailable,
  openDatabase,
} from "../gsd-db.ts";
import { captureCurrentLegacyImportBaseSnapshot } from "../legacy-import-preview-base.ts";
import { fingerprintLegacyImportCorpusTree } from "./helpers/legacy-import-corpus.ts";

const CANONICAL_TABLES = [
  "milestones",
  "slices",
  "tasks",
  "slice_dependencies",
  "requirements",
  "decisions",
  "memories",
  "artifacts",
  "assessments",
  "workflow_item_lifecycles",
] as const;
const LINEAGE_TABLES = [
  "workflow_execution_attempts",
  "workflow_attempt_results",
  "workflow_kernel_checkpoints",
  "workflow_operations",
  "workflow_import_applications",
  "workflow_domain_events",
  "workflow_outbox",
  "workflow_projection_work",
  "workflow_recovery_actions",
  "workflow_recovery_budgets",
] as const;
const temporaryDirectories = new Set<string>();

interface Notification {
  message: string;
  level: string;
}

function db(): NonNullable<ReturnType<typeof _getAdapter>> {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function tableSnapshot(tables: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(tables.map((table) => [
    table,
    db().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  ]));
}

function durableSnapshot(): Record<string, unknown> {
  return {
    base: captureCurrentLegacyImportBaseSnapshot(),
    authority: db().prepare("SELECT * FROM project_authority ORDER BY rowid").all(),
    canonical: tableSnapshot(CANONICAL_TABLES),
    lineage: tableSnapshot(LINEAGE_TABLES),
    totalChanges: Number(db().prepare("SELECT total_changes() AS count").get()?.["count"]),
  };
}

function makeWorkspace(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-sync-fail-closed-"));
  temporaryDirectories.add(base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Canonical milestone", status: "active" });
  insertSlice({
    milestoneId: "M001",
    id: "S01",
    title: "Canonical slice",
    status: "pending",
    risk: "low",
    depends: [],
    sequence: 1,
  });
  insertTask({
    milestoneId: "M001",
    sliceId: "S01",
    id: "T01",
    title: "Canonical task",
    status: "pending",
  });
  return base;
}

function makeContext(): { ctx: ExtensionCommandContext; notifications: Notification[] } {
  const notifications: Notification[] = [];
  const ctx = {
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications };
}

function markerBytes(base: string): Buffer {
  return readFileSync(join(base, ".gsd", ".compat.json"));
}

function projectionTreeSnapshot(root: string, relative = ""): string[] {
  const rows: string[] = [];
  const entries = readdirSync(join(root, relative), { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (
      child === ".compat.json"
      || child === "gsd.db"
      || child === "gsd.db-wal"
      || child === "gsd.db-shm"
    ) {
      continue;
    }
    if (entry.isDirectory()) {
      rows.push(`${child}/`);
      rows.push(...projectionTreeSnapshot(root, child));
    } else {
      rows.push(`${child}:${readFileSync(join(root, child)).toString("base64")}`);
    }
  }
  return rows;
}

function assertFailClosedGuidance(
  notifications: readonly Notification[],
  explicitImportRoute: RegExp,
): void {
  assert.equal(notifications.length, 1, "sync reports one terminal outcome");
  const notification = notifications[0]!;
  assert.match(notification.level, /warning|error/, "modeled drift is not reported as success");
  assert.match(notification.message, /\/gsd rebuild markdown/);
  assert.match(notification.message, /DB|database/i, "rebuild guidance identifies the DB-wins route");
  assert.match(notification.message, explicitImportRoute);
  assert.match(notification.message, /import|markdown/i, "recovery guidance identifies intentional import");
}

afterEach(() => {
  if (isDbAvailable()) closeDatabase();
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

test("/gsd sync blocks modeled .gsd drift without importing or rendering over it", async () => {
  const base = makeWorkspace();
  const relativePath = "phases/01-canonical/01-ROADMAP.md";
  const sourcePath = join(base, ".gsd", relativePath);
  mkdirSync(join(base, ".gsd", "phases", "01-canonical"), { recursive: true });
  writeFileSync(
    sourcePath,
    [
      "# M001: Edited projection",
      "",
      "**Vision:** This external edit requires an explicit authority choice.",
      "",
      "## Slices",
      "",
      "- [x] **S01: Edited projection slice** `risk:high` `depends:[]`",
      "",
    ].join("\n"),
  );
  const siblingPath = join(base, ".gsd", "phases", "01-canonical", "01-CONTEXT.md");
  writeFileSync(siblingPath, "# Unrelated sibling projection\n");
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-07-01T00:00:00.000Z",
    projections: {
      [relativePath]: { sha: "stale000000000000", entities: ["M001", "M001/S01"] },
    },
    planning: { active: false, layout: null, projections: {}, passthrough: {} },
    piVersion: "test",
  });
  const databaseBefore = durableSnapshot();
  const markerBefore = markerBytes(base);
  const projectionBefore = projectionTreeSnapshot(join(base, ".gsd"));
  const { ctx, notifications } = makeContext();

  await handleSync(ctx, base);

  assertFailClosedGuidance(notifications, /\/gsd recover/);
  assert.deepEqual(markerBytes(base), markerBefore, "sync does not advance the stale marker baseline");
  assert.deepEqual(
    projectionTreeSnapshot(join(base, ".gsd")),
    projectionBefore,
    "blocked sync leaves the whole modeled .gsd projection tree exact",
  );
  assert.deepEqual(durableSnapshot(), databaseBefore, "DB authority, lineage, and total_changes remain exact");
});

test("/gsd sync blocks modeled active .planning drift without transform or import", async () => {
  const base = makeWorkspace();
  mkdirSync(join(base, ".planning"), { recursive: true });
  writeFileSync(
    join(base, ".planning", "ROADMAP.md"),
    "# Roadmap\n\n## Phases\n\n- [x] 01 — Edited projection\n",
  );
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-07-01T00:00:00.000Z",
    projections: {},
    planning: {
      active: true,
      layout: "flat-phases",
      projections: {
        "ROADMAP.md": { sha: "stale000000000000", entities: ["M001"] },
      },
      passthrough: {},
    },
    piVersion: "test",
  });
  const databaseBefore = durableSnapshot();
  const markerBefore = markerBytes(base);
  const planningBefore = fingerprintLegacyImportCorpusTree(join(base, ".planning"));
  const projectionBefore = projectionTreeSnapshot(join(base, ".gsd"));
  const { ctx, notifications } = makeContext();

  await handleSync(ctx, base);

  assertFailClosedGuidance(notifications, /\/gsd migrate/);
  assert.match(notifications[0]?.message ?? "", /Preview\/Application/);
  assert.equal(
    fingerprintLegacyImportCorpusTree(join(base, ".planning")),
    planningBefore,
    "edited planning bytes remain exact",
  );
  assert.deepEqual(markerBytes(base), markerBefore, "sync does not advance the planning marker");
  assert.deepEqual(durableSnapshot(), databaseBefore, "DB authority, lineage, and total_changes remain exact");
  assert.deepEqual(
    projectionTreeSnapshot(join(base, ".gsd")),
    projectionBefore,
    "sync does not transform planning content or invoke the renderer",
  );
});

test("/gsd sync still accepts active .planning passthrough drift", async () => {
  const base = makeWorkspace();
  const relativePath = "codebase/STACK.md";
  const sourcePath = join(base, ".planning", relativePath);
  mkdirSync(join(base, ".planning", "codebase"), { recursive: true });
  writeFileSync(sourcePath, "# Updated stack notes\n");
  writeFileSync(join(base, ".planning", "codebase", "ARCHITECTURE.md"), "# User-owned sibling notes\n");
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-07-01T00:00:00.000Z",
    projections: {},
    planning: {
      active: true,
      layout: "flat-phases",
      projections: {},
      passthrough: {
        [relativePath]: { sha: "stale000000000000", entities: [] },
      },
    },
    piVersion: "test",
  });
  const sourceBefore = readFileSync(sourcePath);
  const passthroughTreeBefore = fingerprintLegacyImportCorpusTree(join(base, ".planning", "codebase"));
  const { ctx, notifications } = makeContext();

  await handleSync(ctx, base);

  assert.deepEqual(readFileSync(sourcePath), sourceBefore, "passthrough content remains user-owned");
  assert.equal(
    fingerprintLegacyImportCorpusTree(join(base, ".planning", "codebase")),
    passthroughTreeBefore,
    "safe checksum refresh leaves the complete passthrough subtree exact",
  );
  assert.equal(
    readCompatMarker(base).planning?.passthrough[relativePath]?.sha,
    computeProjectionSha(sourceBefore.toString("utf8")),
    "safe passthrough drift refreshes its marker SHA",
  );
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.level, "info");
  assert.match(notifications[0]?.message ?? "", /passthrough/);
  assert.doesNotMatch(notifications[0]?.message ?? "", /\/gsd rebuild markdown|\/gsd recover/);
});
