import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  _getAdapter,
  closeDatabase,
  getDatabaseReplacementPaths,
  insertDecision,
  openDatabase,
  upsertDecision,
} from "../gsd-db.ts";
import { backfillDecisionsToMemories } from "../memory-backfill.ts";
import {
  createMemorySource,
  deleteMemorySource,
  getMemorySource,
} from "../memory-source-store.ts";
import { createMemory, updateMemoryContent } from "../memory-store.ts";

function decision(supersededBy: string | null) {
  return {
    id: "D001",
    when_context: "during replacement fencing",
    scope: "project",
    decision: "Keep memory writes serialized",
    choice: "engine transaction",
    rationale: "replacement safety",
    revisable: "yes",
    made_by: "agent" as const,
    superseded_by: supersededBy,
  };
}

test("active replacement intent refuses memory insert, update, delete, and backfill drift repair", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-memory-replacement-fence-"));
  const databasePath = join(base, "gsd.db");
  const replacementPaths = getDatabaseReplacementPaths(databasePath);
  t.after(() => {
    try {
      closeDatabase();
    } catch {
      // best effort
    }
    rmSync(base, { recursive: true, force: true });
  });

  openDatabase(databasePath);
  const memoryId = createMemory({ category: "gotcha", content: "preserve this memory" });
  assert.ok(memoryId);
  const source = createMemorySource({ kind: "note", content: "preserve this source" });
  assert.ok(source);

  insertDecision(decision(null));
  assert.equal(backfillDecisionsToMemories(), 1);
  upsertDecision(decision("D002"));

  mkdirSync(replacementPaths.recoveryDirectory, { recursive: true });
  writeFileSync(replacementPaths.activeIntentPath, "{}", { mode: 0o600 });

  assert.equal(
    createMemorySource({ kind: "note", content: "must not be inserted" }),
    null,
    "fenced source insert must refuse",
  );
  assert.equal(
    updateMemoryContent(memoryId, "must not replace existing content"),
    false,
    "fenced memory update must refuse",
  );
  assert.equal(deleteMemorySource(source.id), false, "fenced source delete must refuse");
  assert.equal(backfillDecisionsToMemories(), 0, "fenced drift repair must refuse");

  const adapter = _getAdapter();
  assert.ok(adapter);
  assert.equal(
    adapter.prepare("SELECT count(*) AS count FROM memory_sources").get()?.["count"],
    1,
    "fenced insert must not add a source",
  );
  assert.equal(
    adapter.prepare("SELECT content FROM memories WHERE id = :id").get({ ":id": memoryId })?.["content"],
    "preserve this memory",
    "fenced update must preserve content",
  );
  assert.ok(getMemorySource(source.id), "fenced delete must preserve the source");

  const decisionMemory = adapter
    .prepare("SELECT structured_fields FROM memories WHERE structured_fields LIKE :source")
    .get({ ":source": '%"sourceDecisionId":"D001"%' });
  assert.ok(decisionMemory);
  assert.equal(
    JSON.parse(String(decisionMemory["structured_fields"]))["superseded_by"],
    null,
    "fenced backfill must not drift-heal structured fields",
  );
});
