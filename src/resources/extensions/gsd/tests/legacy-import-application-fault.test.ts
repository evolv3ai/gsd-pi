// Project/App: gsd-pi
// File Purpose: Public fault, crash, restart, and lost-response proof for legacy Import Application.

import assert from "node:assert/strict";
import {
  spawn,
  spawnSync,
  type ChildProcessByStdio,
  type SpawnSyncReturns,
} from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Readable } from "node:stream";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  prepareLegacyImportBackup,
  type LegacyImportVerifiedBackup,
} from "../legacy-import-backup.ts";
import * as applicationModule from "../legacy-import-application.ts";
import {
  LegacyImportApplicationError,
  applyLegacyImport,
  createLegacyImportApplicationConsent,
  createLegacyImportApplicationIdentity,
  type LegacyImportApplicationInput,
  type LegacyImportApplicationReceipt,
} from "../legacy-import-application.ts";
import {
  compileLegacyImportApplicationPlan,
  type LegacyImportApplicationPlan,
} from "../legacy-import-application-plan.ts";
import {
  createLegacyImportPreview,
} from "../legacy-import-preview.ts";
import {
  captureCurrentLegacyImportBaseSnapshot,
  type LegacyImportBaseSnapshot,
} from "../legacy-import-preview-base.ts";
import {
  _setDomainOperationFaultForTest,
  type DomainOperationFaultPoint,
} from "../db/domain-operation.ts";
import type { DbAdapter, DbStatement } from "../db-adapter.ts";
import {
  _getAdapter,
  closeDatabase,
  insertDecision,
  insertMilestone,
  insertSlice,
  openDatabase,
} from "../gsd-db.ts";
import { createLegacyImportCorpusSourceRoots } from "./helpers/legacy-import-corpus.ts";

const CORPUS_ROOT = fileURLToPath(new URL(
  "./__fixtures__/legacy-import-corpus/v1/",
  import.meta.url,
));
const CHILD_PATH = fileURLToPath(new URL("./legacy-import-application-child.ts", import.meta.url));
const RESOLVER_PATH = fileURLToPath(new URL("./resolve-ts.mjs", import.meta.url));
const CHILD_DEADLINE_MS = 30_000;
const tempDirectories = new Set<string>();
let applicationSequence = 0;
let childSequence = 0;

const DOMAIN_PRECOMMIT_FAULTS: readonly DomainOperationFaultPoint[] = [
  "after-operation",
  "after-mutation",
  "after-events",
  "after-outbox",
  "after-projections",
  "before-cas",
];

const APPLICATION_BOUNDARIES = [
  "after-coordination",
  "after-final-validation",
  "after-plan",
  "after-receipt",
] as const;

type ApplicationBoundary = typeof APPLICATION_BOUNDARIES[number];
type ApplicationBoundaryCallback = (boundary: ApplicationBoundary) => void;
type ApplicationBoundarySetter = (callback: ApplicationBoundaryCallback | null) => void;

interface PreparedApplicationCase {
  workspace: string;
  databasePath: string;
  base: LegacyImportBaseSnapshot;
  backup: LegacyImportVerifiedBackup;
  input: LegacyImportApplicationInput;
}

interface ChildConfig {
  databasePath: string;
  applicationInputPath: string;
  applicationBoundary?: ApplicationBoundary;
  domainFault?: DomainOperationFaultPoint;
  crash?: {
    sqlPattern: string;
    occurrence: number;
  };
  barrier?: {
    readyPath: string;
    releasePath: string;
  };
  transactionBarrier?: {
    readyPath: string;
    releasePath: string;
  };
  killAfterApply?: boolean;
  committedPath?: string;
}

type MutationFixture =
  | "gsd-nested"
  | "planning-flat-complete"
  | "decision-create"
  | "row-actions"
  | "decision-actions";

interface MutationFaultCase {
  family: string;
  fixture: MutationFixture;
  sqlPattern: string;
  occurrence: number;
  expectedStage: LegacyImportApplicationError["stage"];
  expectedCode: LegacyImportApplicationError["code"];
}

interface SqlFaultController {
  hitCount(): number;
  restore(): void;
}

interface ChildErrorOutcome {
  code: string;
  message: string;
  stage?: string;
  retryable?: boolean;
}

type ChildOutcome =
  | { receipt: LegacyImportApplicationReceipt }
  | { error: ChildErrorOutcome };

const MUTATION_FAILED = {
  expectedStage: "transaction",
  expectedCode: "LEGACY_IMPORT_APPLICATION_MUTATION_FAILED",
} as const;

const MUTATION_FAULT_CASES: readonly MutationFaultCase[] = [
  { family: "operation insert", fixture: "gsd-nested", sqlPattern: "insert into workflow_operations", occurrence: 1, ...MUTATION_FAILED },
  { family: "row create", fixture: "gsd-nested", sqlPattern: "insert into tasks", occurrence: 1, ...MUTATION_FAILED },
  { family: "dependency replacement", fixture: "gsd-nested", sqlPattern: "insert into slice_dependencies", occurrence: 1, ...MUTATION_FAILED },
  { family: "lifecycle adoption", fixture: "planning-flat-complete", sqlPattern: "insert into workflow_item_lifecycles", occurrence: 1, ...MUTATION_FAILED },
  { family: "decision-memory write", fixture: "decision-create", sqlPattern: "insert into memories", occurrence: 1, ...MUTATION_FAILED },
  {
    family: "receipt insert",
    fixture: "gsd-nested",
    sqlPattern: "insert into workflow_import_applications",
    occurrence: 1,
    expectedStage: "receipt",
    expectedCode: "LEGACY_IMPORT_APPLICATION_RECEIPT_INCONSISTENT",
  },
  { family: "event", fixture: "gsd-nested", sqlPattern: "insert into workflow_domain_events", occurrence: 1, ...MUTATION_FAILED },
  { family: "outbox", fixture: "gsd-nested", sqlPattern: "insert into workflow_outbox", occurrence: 1, ...MUTATION_FAILED },
  { family: "projection work", fixture: "gsd-nested", sqlPattern: "insert into workflow_projection_work", occurrence: 1, ...MUTATION_FAILED },
  { family: "authority CAS", fixture: "gsd-nested", sqlPattern: "update project_authority", occurrence: 1, ...MUTATION_FAILED },
  { family: "row update", fixture: "row-actions", sqlPattern: "update slices set", occurrence: 1, ...MUTATION_FAILED },
  { family: "row delete", fixture: "row-actions", sqlPattern: "delete from slices where", occurrence: 1, ...MUTATION_FAILED },
  {
    family: "dependency deletion",
    fixture: "row-actions",
    sqlPattern: "delete from slice_dependencies where milestone_id = :milestone_id and (slice_id = :slice_id or depends_on_slice_id = :slice_id)",
    occurrence: 1,
    ...MUTATION_FAILED,
  },
  { family: "decision update", fixture: "decision-actions", sqlPattern: "insert into memories", occurrence: 2, ...MUTATION_FAILED },
  { family: "decision delete", fixture: "decision-actions", sqlPattern: "insert into memories", occurrence: 3, ...MUTATION_FAILED },
];

function db(): DbAdapter {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function rows(sql: string, params?: Record<string, unknown>): Array<Record<string, unknown>> {
  const statement = db().prepare(sql);
  return (params === undefined ? statement.all() : statement.all(params)) as Array<Record<string, unknown>>;
}

function tableRows(table: string): Array<Record<string, unknown>> {
  return rows(`SELECT * FROM ${table} ORDER BY rowid`);
}

function durableSnapshot(): Record<string, unknown> {
  return {
    authority: tableRows("project_authority"),
    milestones: tableRows("milestones"),
    slices: tableRows("slices"),
    tasks: tableRows("tasks"),
    dependencies: tableRows("slice_dependencies"),
    requirements: tableRows("requirements"),
    decisions: tableRows("decisions"),
    memories: tableRows("memories"),
    artifacts: tableRows("artifacts"),
    assessments: tableRows("assessments"),
    workers: tableRows("workers"),
    leases: tableRows("milestone_leases"),
    dispatches: tableRows("unit_dispatches"),
    lifecycles: tableRows("workflow_item_lifecycles"),
    attempts: tableRows("workflow_execution_attempts"),
    attemptResults: tableRows("workflow_attempt_results"),
    checkpoints: tableRows("workflow_kernel_checkpoints"),
    operations: tableRows("workflow_operations"),
    applications: tableRows("workflow_import_applications"),
    events: tableRows("workflow_domain_events"),
    outbox: tableRows("workflow_outbox"),
    projections: tableRows("workflow_projection_work"),
  };
}

const ROW_ACTIONS_MANIFEST = {
  version: 1,
  exported_at: "2026-07-17T12:00:00.000Z",
  milestones: [{
    id: "M001",
    title: "Action family fixture",
    status: "pending",
    depends_on: [],
    created_at: "2026-07-17T12:00:00.000Z",
    completed_at: null,
    vision: "Exercise exact row actions.",
    success_criteria: ["Every discriminant is covered"],
    key_risks: [],
    proof_strategy: [],
    verification_contract: "Run focused fault tests.",
    verification_integration: "Use the public Application.",
    verification_operational: "Reopen the database.",
    verification_uat: "No manual step.",
    definition_of_done: ["Rollback is exact"],
    requirement_coverage: "",
    boundary_map_markdown: "manifest -> database",
    sequence: 1,
  }],
  slices: [{
    milestone_id: "M001",
    id: "S01",
    title: "Canonical slice title",
    status: "pending",
    risk: "medium",
    depends: [],
    demo: "Show exact actions.",
    created_at: "2026-07-17T12:00:00.000Z",
    completed_at: null,
    full_summary_md: "",
    full_uat_md: "",
    goal: "Close action coverage.",
    success_criteria: "All row actions execute.",
    proof_level: "integration",
    integration_closure: "Fault tests use physical input.",
    observability_impact: "None.",
    target_repositories: ["open-gsd/gsd-pi"],
    sequence: 1,
    replan_triggered_at: null,
    is_sketch: 0,
    sketch_scope: "",
  }],
  tasks: [],
  decisions: [],
  verification_evidence: [],
};

function instructionDescriptors(plan: LegacyImportApplicationPlan): Array<[string, string]> {
  return plan.instructions.map((instruction) => {
    const value = instruction as unknown as Record<string, unknown>;
    return [instruction.action, String(value["targetKey"] ?? value["decisionId"])] as [string, string];
  });
}

function seedRowActionsBase(): void {
  insertMilestone({
    id: "M001",
    title: "Action family fixture",
    status: "pending",
    planning: {
      vision: "Exercise exact row actions.",
      successCriteria: ["Every discriminant is covered"],
      keyRisks: [],
      proofStrategy: [],
      verificationContract: "Run focused fault tests.",
      verificationIntegration: "Use the public Application.",
      verificationOperational: "Reopen the database.",
      verificationUat: "No manual step.",
      definitionOfDone: ["Rollback is exact"],
      requirementCoverage: "",
      boundaryMapMarkdown: "manifest -> database",
    },
  });
  db().prepare("UPDATE milestones SET sequence = 1 WHERE id = 'M001'").run();
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Stale slice title",
    status: "pending",
    risk: "medium",
    depends: [],
    demo: "Show exact actions.",
    sequence: 1,
    isSketch: false,
    sketchScope: "",
    planning: {
      goal: "Close action coverage.",
      successCriteria: "All row actions execute.",
      proofLevel: "integration",
      integrationClosure: "Fault tests use physical input.",
      observabilityImpact: "None.",
      targetRepositories: ["open-gsd/gsd-pi"],
    },
  });
  insertSlice({
    id: "S02",
    milestoneId: "M001",
    title: "Delete me",
    depends: ["S01"],
  });
  db().prepare(`INSERT INTO slice_dependencies
    (milestone_id, slice_id, depends_on_slice_id) VALUES ('M001', 'S02', 'S01')`).run();
}

function seedDecisionActionsBase(sourceDatabasePath: string): void {
  const sourceDatabase = new DatabaseSync(sourceDatabasePath, { readOnly: true });
  try {
    const decisions = sourceDatabase.prepare(`SELECT id, when_context, scope, decision, choice,
      rationale, revisable, made_by, source, superseded_by FROM decisions ORDER BY id`).all();
    for (const decision of decisions) {
      insertDecision(decision as unknown as Parameters<typeof insertDecision>[0]);
    }
  } finally {
    sourceDatabase.close();
  }
}

function prepareCase(fixture: MutationFixture = "gsd-nested"): PreparedApplicationCase {
  applicationSequence += 1;
  const workspace = mkdtempSync(join(tmpdir(), "gsd-legacy-application-fault-"));
  tempDirectories.add(workspace);
  const source = join(workspace, "source");
  const backupDirectory = join(workspace, "backups");
  const databasePath = join(workspace, "canonical.sqlite");
  if (fixture === "row-actions") {
    mkdirSync(join(source, ".gsd"), { recursive: true });
    writeFileSync(
      join(source, ".gsd", "state-manifest.json"),
      JSON.stringify(ROW_ACTIONS_MANIFEST, null, 2),
      "utf8",
    );
  } else {
    let corpusFixture: string = fixture;
    if (fixture === "decision-create") corpusFixture = "registries";
    if (fixture === "decision-actions") corpusFixture = "action-matrix";
    cpSync(join(CORPUS_ROOT, corpusFixture, "source"), source, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });
  }
  if (fixture === "decision-create") {
    rmSync(join(source, ".gsd", "REQUIREMENTS.md"));
    writeFileSync(join(source, ".gsd", "DECISIONS.md"), `# Decisions Register

| # | When | Scope | Decision | Choice | Rationale | Revisable? | Made By |
|---|------|-------|----------|--------|-----------|------------|---------|
| D001 | M001 | storage | Choose persistence | SQLite | Local durable authority | No | agent |
`, "utf8");
  }
  mkdirSync(backupDirectory);
  assert.equal(openDatabase(databasePath), true);
  if (fixture === "row-actions") seedRowActionsBase();
  if (fixture === "decision-actions") {
    const sourceDatabasePath = join(source, ".gsd", "gsd.db");
    seedDecisionActionsBase(sourceDatabasePath);
    rmSync(sourceDatabasePath);
  }
  const previewInput = { roots: createLegacyImportCorpusSourceRoots(source) };
  const base = captureCurrentLegacyImportBaseSnapshot();
  const preview = createLegacyImportPreview(previewInput);
  if (fixture === "row-actions" || fixture === "decision-actions") {
    assert.equal(preview.preview.counts.unresolved, 0, JSON.stringify({
      diagnoses: preview.preview.diagnoses,
      resolutions: preview.preview.resolutions,
    }));
  }
  const plan = compileLegacyImportApplicationPlan(preview);
  if (fixture === "row-actions") {
    assert.deepEqual(instructionDescriptors(plan), [
      ["update", "M001/S01"],
      ["replace-slice-dependencies", "M001/S01"],
      ["delete-slice-dependencies", "M001/S02"],
      ["delete", "M001/S02"],
    ]);
  }
  if (fixture === "decision-actions") {
    assert.deepEqual(instructionDescriptors(plan), [
      ["create-decision-memory", "D001"],
      ["update-decision-memory", "D002"],
      ["delete-decision-memory", "D003"],
      ["preserve", ".gsd/STATE.md"],
    ]);
  }
  const backup = prepareLegacyImportBackup({
    preview,
    base,
    roots: previewInput.roots,
    destination_directory: backupDirectory,
    label: "pre-application",
  });
  const input: LegacyImportApplicationInput = {
    invocation: {
      idempotencyKey: `legacy-import/fault-${applicationSequence}`,
      sourceTransport: "internal",
      actorType: "agent",
      actorId: "legacy-import-fault-test",
      traceId: `fault-trace-${applicationSequence}`,
      turnId: `fault-turn-${applicationSequence}`,
    },
    previewInput,
    preview,
    backup,
    ...(preview.preview.counts.delete > 0
      ? { destructiveConsent: createLegacyImportApplicationConsent(preview) }
      : {}),
  };
  return { workspace, databasePath, base, backup, input };
}

function normalizedSql(sql: string): string {
  return sql.trim().replace(/\s+/g, " ").toLowerCase();
}

function installSqlException(
  adapter: DbAdapter,
  sqlPattern: string,
  occurrence: number,
): SqlFaultController {
  const originalPrepare = adapter.prepare;
  const pattern = normalizedSql(sqlPattern);
  let hits = 0;
  adapter.prepare = (sql: string): DbStatement => {
    const statement = originalPrepare.call(adapter, sql);
    if (!normalizedSql(sql).includes(pattern)) return statement;
    return {
      ...statement,
      run(...params: unknown[]): unknown {
        const result = statement.run(...params);
        hits += 1;
        if (hits === occurrence) {
          throw new Error(`injected SQL fault after ${sqlPattern} occurrence ${occurrence}`);
        }
        return result;
      },
    };
  };
  return {
    hitCount: () => hits,
    restore: () => {
      adapter.prepare = originalPrepare;
    },
  };
}

function boundarySetter(): ApplicationBoundarySetter {
  const candidate = (applicationModule as unknown as Record<string, unknown>)[
    "_setLegacyImportApplicationBoundaryForTest"
  ];
  assert.equal(
    typeof candidate,
    "function",
    "legacy Import Application requires a private named-boundary test seam",
  );
  return candidate as ApplicationBoundarySetter;
}

function expectTransactionFailure(run: () => unknown): LegacyImportApplicationError {
  let observed: unknown;
  try {
    run();
  } catch (error) {
    observed = error;
  }
  assert.ok(observed instanceof LegacyImportApplicationError);
  assert.equal(observed.stage, "transaction");
  assert.equal(observed.code, "LEGACY_IMPORT_APPLICATION_MUTATION_FAILED");
  assert.equal(observed.retryable, false);
  return observed;
}

function reopenAndSnapshot(prepared: PreparedApplicationCase): Record<string, unknown> {
  closeDatabase();
  assert.equal(openDatabase(prepared.databasePath), true);
  assert.deepEqual(db().prepare("PRAGMA integrity_check").get(), { integrity_check: "ok" });
  return durableSnapshot();
}

function runChild(
  prepared: PreparedApplicationCase,
  config: Omit<ChildConfig, "databasePath" | "applicationInputPath">,
): SpawnSyncReturns<string> {
  const applicationInputPath = join(prepared.workspace, `application-input-${applicationSequence}.json`);
  const configPath = join(prepared.workspace, `child-config-${applicationSequence}.json`);
  writeFileSync(applicationInputPath, JSON.stringify(prepared.input), "utf8");
  writeFileSync(configPath, JSON.stringify({
    databasePath: prepared.databasePath,
    applicationInputPath,
    ...config,
  } satisfies ChildConfig), "utf8");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [
    "--import",
    RESOLVER_PATH,
    "--experimental-strip-types",
    CHILD_PATH,
    configPath,
  ], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    timeout: CHILD_DEADLINE_MS,
  });
}

function prepareSiblingCase(
  prepared: PreparedApplicationCase,
  fixture: "gsd-nested" | "planning-flat-complete",
  expectedBase: LegacyImportBaseSnapshot = prepared.base,
): PreparedApplicationCase {
  applicationSequence += 1;
  const source = join(prepared.workspace, `source-${fixture}-${applicationSequence}`);
  const backupDirectory = join(prepared.workspace, `backups-${fixture}-${applicationSequence}`);
  cpSync(join(CORPUS_ROOT, fixture, "source"), source, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  mkdirSync(backupDirectory);
  const previewInput = { roots: createLegacyImportCorpusSourceRoots(source) };
  const base = captureCurrentLegacyImportBaseSnapshot();
  assert.deepEqual(base, expectedBase);
  const preview = createLegacyImportPreview(previewInput);
  const backup = prepareLegacyImportBackup({
    preview,
    base,
    roots: previewInput.roots,
    destination_directory: backupDirectory,
    label: "pre-application-sibling",
  });
  const input: LegacyImportApplicationInput = {
    invocation: {
      idempotencyKey: `legacy-import/fault-${applicationSequence}`,
      sourceTransport: "internal",
      actorType: "agent",
      actorId: "legacy-import-fault-test",
      traceId: `fault-trace-${applicationSequence}`,
      turnId: `fault-turn-${applicationSequence}`,
    },
    previewInput,
    preview,
    backup,
  };
  return { ...prepared, base, backup, input };
}

function spawnChild(
  prepared: PreparedApplicationCase,
  input: LegacyImportApplicationInput,
  config: Omit<ChildConfig, "databasePath" | "applicationInputPath">,
): ChildProcessByStdio<null, Readable, Readable> {
  childSequence += 1;
  const suffix = `${applicationSequence}-${childSequence}`;
  const applicationInputPath = join(prepared.workspace, `application-input-${suffix}.json`);
  const configPath = join(prepared.workspace, `child-config-${suffix}.json`);
  writeFileSync(applicationInputPath, JSON.stringify(input), "utf8");
  writeFileSync(configPath, JSON.stringify({
    databasePath: prepared.databasePath,
    applicationInputPath,
    ...config,
  } satisfies ChildConfig), "utf8");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawn(process.execPath, [
    "--import",
    RESOLVER_PATH,
    "--experimental-strip-types",
    CHILD_PATH,
    configPath,
  ], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function collectChild(
  child: ChildProcessByStdio<null, Readable, Readable>,
  timeoutMs = CHILD_DEADLINE_MS,
): Promise<ChildOutcome> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child outcome timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || signal !== null) {
        reject(new Error(stderr || stdout || `child exited with code ${code} signal ${signal}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()) as ChildOutcome);
      } catch (error) {
        reject(new Error(`child emitted invalid JSON: ${stdout}`, { cause: error }));
      }
    });
  });
}

async function waitForPath(path: string, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}: ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForChildReady(
  path: string,
  label: string,
  index: number,
  outcome: Promise<ChildOutcome>,
): Promise<void> {
  const earlyOutcome = await Promise.race([
    waitForPath(path, CHILD_DEADLINE_MS, label).then(() => null),
    outcome,
  ]);
  if (earlyOutcome) {
    throw new Error(`child ${index} exited before ${label}: ${JSON.stringify(earlyOutcome)}`);
  }
}

async function runConcurrentApplications(
  prepared: PreparedApplicationCase,
  inputs: readonly [LegacyImportApplicationInput, LegacyImportApplicationInput],
): Promise<readonly [ChildOutcome, ChildOutcome]> {
  const startRelease = join(prepared.workspace, `start-release-${childSequence}`);
  const transactionRelease = join(prepared.workspace, `transaction-release-${childSequence}`);
  const startReady = inputs.map((_, index) => join(prepared.workspace, `start-ready-${childSequence}-${index}`));
  const transactionReady = inputs.map((_, index) => (
    join(prepared.workspace, `transaction-ready-${childSequence}-${index}`)
  ));
  const children: ChildProcessByStdio<null, Readable, Readable>[] = [];
  const outcomes: Promise<ChildOutcome>[] = [];
  try {
    for (const [index, input] of inputs.entries()) {
      const child = spawnChild(prepared, input, {
        barrier: { readyPath: startReady[index]!, releasePath: startRelease },
        transactionBarrier: { readyPath: transactionReady[index]!, releasePath: transactionRelease },
      });
      const outcome = collectChild(child);
      children.push(child);
      outcomes.push(outcome);
      await waitForChildReady(startReady[index]!, "start barrier", index, outcome);
    }
    writeFileSync(startRelease, "release", "utf8");
    await Promise.all(transactionReady.map((path, index) => (
      waitForChildReady(path, "transaction barrier", index, outcomes[index]!)
    )));
    writeFileSync(transactionRelease, "release", "utf8");
    return await Promise.all(outcomes) as [ChildOutcome, ChildOutcome];
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await Promise.allSettled(outcomes);
  }
}

function assertSingleImportLineage(
  prepared: PreparedApplicationCase,
  winningReceipt: LegacyImportApplicationReceipt,
): void {
  assert.deepEqual(rows("SELECT revision, authority_epoch FROM project_authority"), [{
    revision: prepared.base.authority.revision + 1,
    authority_epoch: prepared.base.authority.authority_epoch,
  }]);
  const operations = tableRows("workflow_operations");
  const applications = tableRows("workflow_import_applications");
  const events = tableRows("workflow_domain_events");
  const outbox = tableRows("workflow_outbox");
  const projections = tableRows("workflow_projection_work");
  assert.equal(operations.length, 1);
  assert.equal(applications.length, 1);
  assert.equal(events.length, 1);
  assert.equal(outbox.length, 1);
  assert.ok(projections.length > 0);
  const operationId = winningReceipt.operationId;
  assert.equal(operations[0]?.["operation_id"], operationId);
  assert.equal(applications[0]?.["operation_id"], operationId);
  assert.equal(events[0]?.["operation_id"], operationId);
  assert.deepEqual(
    projections.map((row) => row["projection_work_id"]),
    winningReceipt.projectionWorkIds,
  );
  assert.ok(projections.every((row) => row["enqueue_operation_id"] === operationId));
}

function assertCommittedReplayConflict(
  outcomes: readonly [ChildOutcome, ChildOutcome],
): LegacyImportApplicationReceipt {
  const receipts = outcomes.flatMap((outcome) => "receipt" in outcome ? [outcome.receipt] : []);
  const errors = outcomes.flatMap((outcome) => "error" in outcome ? [outcome.error] : []);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.status, "committed");
  assert.deepEqual(errors, [{
    code: "LEGACY_IMPORT_APPLICATION_REPLAY_CONFLICT",
    message: "legacy import replay identity differs from the committed Application",
    stage: "replay",
    retryable: false,
  }]);
  return receipts[0]!;
}

function expectReplayConflict(input: LegacyImportApplicationInput): LegacyImportApplicationError {
  let observed: unknown;
  try {
    applyLegacyImport(input);
  } catch (error) {
    observed = error;
  }
  assert.ok(observed instanceof LegacyImportApplicationError);
  assert.equal(observed.stage, "replay");
  assert.equal(observed.code, "LEGACY_IMPORT_APPLICATION_REPLAY_CONFLICT");
  assert.equal(observed.retryable, false);
  return observed;
}

function assertReceiptMatchesDurable(
  prepared: PreparedApplicationCase,
  receipt: LegacyImportApplicationReceipt,
): void {
  const operation = db().prepare(
    "SELECT * FROM workflow_operations WHERE operation_id = :operation_id",
  ).get({ ":operation_id": receipt.operationId });
  const application = db().prepare(
    "SELECT * FROM workflow_import_applications WHERE operation_id = :operation_id",
  ).get({ ":operation_id": receipt.operationId });
  assert.ok(operation);
  assert.ok(application);
  assert.deepEqual(receipt, {
    status: "replayed",
    operationId: operation["operation_id"],
    projectId: operation["project_id"],
    applicationIdentityHash: createLegacyImportApplicationIdentity(prepared.input).applicationIdentityHash,
    previewId: application["preview_id"],
    previewHash: application["preview_hash"],
    backupId: prepared.backup.backup_id,
    baseProjectRevision: operation["expected_revision"],
    baseAuthorityEpoch: operation["expected_authority_epoch"],
    resultingRevision: operation["resulting_revision"],
    resultingAuthorityEpoch: operation["resulting_authority_epoch"],
    appliedAt: application["applied_at"],
    eventIds: rows(`SELECT event_id FROM workflow_domain_events
      WHERE operation_id = :operation_id ORDER BY event_index`, {
      ":operation_id": receipt.operationId,
    }).map((row) => row["event_id"]),
    outboxIds: rows(`SELECT outbox.outbox_id
      FROM workflow_outbox outbox
      JOIN workflow_domain_events event ON event.event_id = outbox.event_id
      WHERE event.operation_id = :operation_id ORDER BY outbox.outbox_id`, {
      ":operation_id": receipt.operationId,
    }).map((row) => row["outbox_id"]),
    projectionWorkIds: rows(`SELECT projection_work_id FROM workflow_projection_work
      WHERE enqueue_operation_id = :operation_id ORDER BY projection_work_id`, {
      ":operation_id": receipt.operationId,
    }).map((row) => row["projection_work_id"]),
  });
}

afterEach(() => {
  _setDomainOperationFaultForTest(null);
  const candidate = (applicationModule as unknown as Record<string, unknown>)[
    "_setLegacyImportApplicationBoundaryForTest"
  ];
  if (typeof candidate === "function") (candidate as ApplicationBoundarySetter)(null);
  closeDatabase();
  for (const directory of tempDirectories) rmSync(directory, { recursive: true, force: true });
  tempDirectories.clear();
});

for (const fault of DOMAIN_PRECOMMIT_FAULTS) {
  test(`public Application ${fault} exception rolls back every durable surface after reopen`, () => {
    const prepared = prepareCase();
    const before = durableSnapshot();
    _setDomainOperationFaultForTest(fault);

    expectTransactionFailure(() => applyLegacyImport(prepared.input));

    _setDomainOperationFaultForTest(null);
    assert.deepEqual(reopenAndSnapshot(prepared), before);
  });
}

for (const boundary of APPLICATION_BOUNDARIES) {
  test(`public Application ${boundary} exception rolls back every durable surface after reopen`, () => {
    const prepared = prepareCase();
    const before = durableSnapshot();
    let hits = 0;
    boundarySetter()((observed) => {
      if (observed !== boundary) return;
      hits += 1;
      throw new Error(`injected Application fault at ${boundary}`);
    });

    expectTransactionFailure(() => applyLegacyImport(prepared.input));

    boundarySetter()(null);
    assert.equal(hits, 1);
    assert.deepEqual(reopenAndSnapshot(prepared), before);
  });

  test(`public Application ${boundary} SIGKILL rolls back every durable surface after reopen`, {
    concurrency: false,
  }, () => {
    const prepared = prepareCase();
    const before = durableSnapshot();
    closeDatabase();

    const child = runChild(prepared, { applicationBoundary: boundary });

    assert.equal(child.status, null, child.stderr || child.stdout);
    assert.equal(child.signal, "SIGKILL", child.stderr || child.stdout);
    assert.deepEqual(reopenAndSnapshot(prepared), before);
  });
}

for (const faultCase of MUTATION_FAULT_CASES) {
  test(`public Application mutation SQL ${faultCase.family} exception rolls back exact pre-state`, () => {
    const prepared = prepareCase(faultCase.fixture);
    const before = durableSnapshot();
    const controller = installSqlException(db(), faultCase.sqlPattern, faultCase.occurrence);
    let observed: unknown;

    try {
      applyLegacyImport(prepared.input);
    } catch (error) {
      observed = error;
    } finally {
      controller.restore();
    }

    assert.equal(controller.hitCount(), faultCase.occurrence, `${faultCase.sqlPattern} was not reached`);
    assert.ok(observed instanceof LegacyImportApplicationError);
    assert.equal(observed.stage, faultCase.expectedStage);
    assert.equal(observed.code, faultCase.expectedCode);
    assert.equal(observed.retryable, false);
    assert.deepEqual(reopenAndSnapshot(prepared), before);
  });

  test(`public Application mutation SQL ${faultCase.family} SIGKILL rolls back exact pre-state`, {
    concurrency: false,
  }, () => {
    const prepared = prepareCase(faultCase.fixture);
    const before = durableSnapshot();
    closeDatabase();

    const child = runChild(prepared, {
      crash: {
        sqlPattern: faultCase.sqlPattern,
        occurrence: faultCase.occurrence,
      },
    });

    assert.equal(child.status, null, child.stderr || child.stdout);
    assert.equal(child.signal, "SIGKILL", child.stderr || child.stdout);
    assert.deepEqual(reopenAndSnapshot(prepared), before);
  });
}

test("lost response after commit reopens and returns the exact durable public receipt", {
  concurrency: false,
}, () => {
  const prepared = prepareCase();
  const before = durableSnapshot();
  const committedPath = join(prepared.workspace, "committed-receipt.json");
  closeDatabase();

  const child = runChild(prepared, { killAfterApply: true, committedPath });

  assert.equal(child.status, null, child.stderr || child.stdout);
  assert.equal(child.signal, "SIGKILL", child.stderr || child.stdout);
  const committed = reopenAndSnapshot(prepared);
  assert.notDeepEqual(committed, before);
  assert.deepEqual(rows("SELECT revision, authority_epoch FROM project_authority"), [{
    revision: prepared.base.authority.revision + 1,
    authority_epoch: prepared.base.authority.authority_epoch,
  }]);
  assert.equal((committed.operations as unknown[]).length, 1);
  assert.equal((committed.applications as unknown[]).length, 1);
  const afterKill = durableSnapshot();
  const original = JSON.parse(readFileSync(committedPath, "utf8")) as LegacyImportApplicationReceipt;
  assert.equal(original.status, "committed");
  assertSingleImportLineage(prepared, original);

  const replayed = applyLegacyImport(prepared.input);

  assert.deepEqual(replayed, { ...original, status: "replayed" });
  assertReceiptMatchesDurable(prepared, replayed);
  assert.deepEqual(durableSnapshot(), afterKill);
  assert.deepEqual(applyLegacyImport(structuredClone(prepared.input)), replayed);
  assert.deepEqual(durableSnapshot(), afterKill);
});

test("two processes with the same key and input commit once and return receipt-equivalent replay", {
  concurrency: false,
}, async () => {
  const prepared = prepareCase();
  closeDatabase();

  const outcomes = await runConcurrentApplications(prepared, [prepared.input, prepared.input]);

  const receipts = outcomes.flatMap((outcome) => "receipt" in outcome ? [outcome.receipt] : []);
  assert.deepEqual(receipts.map((receipt) => receipt.status).sort(), ["committed", "replayed"]);
  const [first, second] = receipts.map(({ status: _status, ...receipt }) => receipt);
  assert.deepEqual(first, second);
  reopenAndSnapshot(prepared);
  const committed = receipts.find((receipt) => receipt.status === "committed");
  assert.ok(committed);
  assertSingleImportLineage(prepared, committed);
});

test("two processes with different keys for one Preview commit once and return typed replay conflict", {
  concurrency: false,
}, async () => {
  const prepared = prepareCase();
  const competingInput: LegacyImportApplicationInput = {
    ...structuredClone(prepared.input),
    invocation: {
      ...structuredClone(prepared.input.invocation),
      idempotencyKey: `${prepared.input.invocation.idempotencyKey}-competing`,
    },
  };
  closeDatabase();

  const outcomes = await runConcurrentApplications(prepared, [prepared.input, competingInput]);

  const receipts = outcomes.flatMap((outcome) => "receipt" in outcome ? [outcome.receipt] : []);
  const errors = outcomes.flatMap((outcome) => "error" in outcome ? [outcome.error] : []);
  assert.equal(receipts.length, 1);
  assert.deepEqual(errors, [{
    code: "LEGACY_IMPORT_APPLICATION_REPLAY_CONFLICT",
    message: "legacy import durable identity does not match the requested key and Preview",
    stage: "replay",
    retryable: false,
  }]);
  reopenAndSnapshot(prepared);
  assertSingleImportLineage(prepared, receipts[0]!);
});

test("two distinct valid corpus requests from one base commit once and return typed authority stale", {
  concurrency: false,
}, async () => {
  const prepared = prepareCase("gsd-nested");
  const sibling = prepareSiblingCase(prepared, "planning-flat-complete");
  closeDatabase();

  const outcomes = await runConcurrentApplications(prepared, [prepared.input, sibling.input]);

  const receipts = outcomes.flatMap((outcome) => "receipt" in outcome ? [outcome.receipt] : []);
  const errors = outcomes.flatMap((outcome) => "error" in outcome ? [outcome.error] : []);
  assert.equal(receipts.length, 1);
  assert.deepEqual(errors, [{
    code: "LEGACY_IMPORT_APPLICATION_AUTHORITY_STALE",
    message: "legacy import authority changed after approval",
    stage: "transaction",
    retryable: false,
  }]);
  reopenAndSnapshot(prepared);
  assertSingleImportLineage(prepared, receipts[0]!);
});

test("two processes with changed invocation under one key commit once and replay-conflict once", {
  concurrency: false,
}, async () => {
  const prepared = prepareCase();
  const changedInvocation: LegacyImportApplicationInput = {
    ...structuredClone(prepared.input),
    invocation: {
      ...structuredClone(prepared.input.invocation),
      actorId: "changed-invocation-racer",
    },
  };
  closeDatabase();

  const outcomes = await runConcurrentApplications(prepared, [prepared.input, changedInvocation]);
  const committed = assertCommittedReplayConflict(outcomes);

  reopenAndSnapshot(prepared);
  assertSingleImportLineage(prepared, committed);
});

test("two valid different Previews under one key commit once and replay-conflict once", {
  concurrency: false,
}, async () => {
  const prepared = prepareCase("gsd-nested");
  const sibling = prepareSiblingCase(prepared, "planning-flat-complete");
  const changedPreview: LegacyImportApplicationInput = {
    ...sibling.input,
    invocation: structuredClone(prepared.input.invocation),
  };
  closeDatabase();

  const outcomes = await runConcurrentApplications(prepared, [prepared.input, changedPreview]);
  const committed = assertCommittedReplayConflict(outcomes);

  reopenAndSnapshot(prepared);
  assertSingleImportLineage(prepared, committed);
});

test("same committed key rejects a different valid Preview and matching original-base backup", () => {
  const prepared = prepareCase("gsd-nested");
  const different = prepareSiblingCase(prepared, "planning-flat-complete");
  const conflictInput: LegacyImportApplicationInput = {
    ...different.input,
    invocation: structuredClone(prepared.input.invocation),
  };
  applyLegacyImport(prepared.input);
  const committed = JSON.stringify(durableSnapshot());

  expectReplayConflict(conflictInput);

  assert.equal(JSON.stringify(durableSnapshot()), committed);
});

test("same committed key rejects a valid new-base Preview and matching revision-plus-one backup", () => {
  const prepared = prepareCase("gsd-nested");
  applyLegacyImport(prepared.input);
  const committed = JSON.stringify(durableSnapshot());
  const newBase = captureCurrentLegacyImportBaseSnapshot();
  assert.equal(newBase.authority.revision, prepared.base.authority.revision + 1);
  assert.equal(newBase.authority.authority_epoch, prepared.base.authority.authority_epoch);
  const rebased = prepareSiblingCase(prepared, "gsd-nested", newBase);
  const conflictInput: LegacyImportApplicationInput = {
    ...rebased.input,
    invocation: structuredClone(prepared.input.invocation),
  };

  expectReplayConflict(conflictInput);

  assert.equal(JSON.stringify(durableSnapshot()), committed);
});
