// Project/App: gsd-pi
// File Purpose: Pure preservation-only interpretation of captured workflow definitions and run artifacts.

import { compareText } from "./legacy-import-utils.js";

import { parse as parseYaml } from "yaml";

import { validateDefinition } from "./definition-loader.js";
import {
  addLegacyImportCandidate,
  addLegacyImportDiagnosis,
  type LegacyImportDecodedSourceFile,
  type LegacyImportPendingCandidate,
  type LegacyImportPendingDiagnosis,
} from "./legacy-import-preview-interpretation.js";
import { parseLegacyImportJson, type LegacyImportJsonDocument } from "./legacy-import-preview-json.js";
import { hashLegacyImportBytes, hashLegacyImportValue } from "./legacy-import-preview.js";

type SourceFile = LegacyImportDecodedSourceFile;
type PendingCandidate = LegacyImportPendingCandidate;
type PendingDiagnosis = LegacyImportPendingDiagnosis;

export interface LegacyGsdWorkflowInterpretationContext {
  bundledDefinitionNames?: readonly string[];
}

interface DefinitionRecord {
  file: SourceFile;
  name: string;
  tier: "current" | "legacy" | "global" | "bundled";
  priority: number;
  semantic?: unknown;
}

interface RunRecord {
  workflow: string;
  runId: string;
  definition?: SourceFile;
  graph?: SourceFile;
  params?: SourceFile;
}

interface ByteSpan {
  start: number;
  end: number;
}

const SENSITIVE_KEY = /(?:api[_-]?key|secret|token|password|passwd|pwd|credential)/iu;
const RUN_PATH = /^\.gsd\/workflow-runs\/([^/]+)\/([^/]+)\/(DEFINITION\.yaml|GRAPH\.yaml|PARAMS\.json)$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textSpan(file: SourceFile, value: string): ByteSpan | undefined {
  const bytes = Buffer.from(value);
  const start = file.bytes.indexOf(bytes);
  return start < 0 ? undefined : { start, end: start + bytes.length };
}

function lastContentLineSpan(file: SourceFile): ByteSpan {
  const line = [...file.lines].reverse().find((candidate) => candidate.text.trim().length > 0);
  if (line === undefined) return { start: 0, end: file.bytes.length };
  const newlineEnd = line.end < file.bytes.length && file.bytes[line.end] === 10 ? line.end + 1 : line.end;
  return { start: line.start, end: newlineEnd };
}

function lineSpan(file: SourceFile, value: string): ByteSpan | undefined {
  const span = textSpan(file, value);
  if (span === undefined) return undefined;
  const line = file.lines.find((candidate) => candidate.start <= span.start && candidate.end >= span.end);
  return line === undefined ? span : { start: line.start, end: line.end };
}

function lineAtByte(file: SourceFile, start: number): number {
  let line = 1;
  for (const candidate of file.lines) {
    if (candidate.start > start) break;
    line = candidate.line;
  }
  return line;
}

function definitionName(value: unknown): string | undefined {
  return isRecord(value) && typeof value.name === "string" ? value.name : undefined;
}

function markdownTitle(file: SourceFile): string | undefined {
  const heading = file.lines.find((line) => /^#\s+\S/u.test(line.text));
  return heading?.text.replace(/^#\s+/u, "");
}

function definitionIdentity(path: string): Omit<DefinitionRecord, "file" | "semantic"> | undefined {
  let match = /^\.gsd\/workflows\/([^/]+)\.(?:yaml|yml|md)$/iu.exec(path);
  if (match !== null) return { name: match[1], tier: "current", priority: 3 };
  match = /^\.gsd\/workflow-defs\/([^/]+)\.(?:yaml|yml)$/iu.exec(path);
  if (match !== null) return { name: match[1], tier: "legacy", priority: 2 };
  match = /^(?:gsd-home|\$GSD_HOME)\/workflows\/([^/]+)\.(?:yaml|yml|md)$/iu.exec(path);
  if (match !== null) return { name: match[1], tier: "global", priority: 1 };
  match = /^\$GSD_BUNDLED_WORKFLOWS\/([^/]+)\.(?:yaml|yml|md)$/iu.exec(path);
  return match === null ? undefined : { name: match[1], tier: "bundled", priority: 0 };
}

function markDefinition(file: SourceFile): void {
  file.parserId = "gsd-workflow-definition";
  file.parserVersion = "1";
  file.kind = file.entry.logical_path.toLowerCase().endsWith(".md") ? "markdown" : "yaml";
}

function parseDefinition(file: SourceFile, diagnoses: PendingDiagnosis[]): unknown | undefined {
  markDefinition(file);
  if (file.encoding !== "utf-8") {
    file.outcome = "unparsed";
    addLegacyImportDiagnosis(
      diagnoses, file, "malformed-workflow-definition", "warning",
      "The workflow definition is preserved as bytes but cannot be parsed as YAML.", "preserved",
    );
    return undefined;
  }
  if (file.kind === "markdown") {
    file.outcome = "preserved";
    return { markdown: file.text };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(file.text, { schema: "core" });
  } catch {
    file.outcome = "unparsed";
    const span = lastContentLineSpan(file);
    addLegacyImportDiagnosis(
      diagnoses, file, "malformed-workflow-definition", "warning",
      "The workflow definition is preserved as bytes but cannot be parsed as YAML.", "preserved",
      span.start, span.end,
    );
    return undefined;
  }
  if (!validateDefinition(parsed).valid) {
    file.outcome = "unparsed";
    const version = isRecord(parsed) ? parsed.version : undefined;
    const span = textSpan(file, `version: ${String(version)}`) ?? lastContentLineSpan(file);
    addLegacyImportDiagnosis(
      diagnoses, file, "unsupported-workflow-definition-version", "warning",
      "The YAML parses, but the workflow definition is not valid under the V1 schema.", "preserved",
      span.start, span.end,
    );
    return undefined;
  }
  file.outcome = "preserved";
  return parsed;
}

function preserveDefinition(record: DefinitionRecord, candidates: PendingCandidate[]): void {
  addLegacyImportCandidate(
    candidates,
    record.file,
    { kind: "legacy-workflow-definition", key: record.file.entry.logical_path },
    { path: record.file.entry.logical_path, preservation: "verbatim" },
    "workflow-definition-is-evidence-only",
    0,
    record.file.bytes.length,
    "preserve",
  );
}

function lowerPrecedenceDiagnosis(record: DefinitionRecord, diagnoses: PendingDiagnosis[]): void {
  const legacy = record.tier === "legacy";
  record.file.outcome = "ignored-with-reason";
  const span = textSpan(record.file, definitionName(record.semantic) ?? record.name);
  addLegacyImportDiagnosis(
    diagnoses,
    record.file,
    "lower-precedence-workflow-ignored",
    "info",
    legacy
      ? "The legacy project definition is excluded because the current project workflow directory has higher precedence."
      : "The global workflow is excluded because a project workflow with the same filename has higher precedence.",
    "preserved",
    span?.start, span?.end,
  );
}

function resolveDefinitions(
  files: readonly SourceFile[],
  candidates: PendingCandidate[],
  diagnoses: PendingDiagnosis[],
  bundledNames: readonly string[],
): Map<string, DefinitionRecord> {
  const records = files.flatMap((file) => {
    const identity = definitionIdentity(file.entry.logical_path);
    if (identity === undefined) return [];
    return [{ file, ...identity, semantic: parseDefinition(file, diagnoses) }];
  });
  const valid = records.filter((record) => record.semantic !== undefined);
  const grouped = new Map<string, DefinitionRecord[]>();
  for (const record of valid) grouped.set(record.name, [...(grouped.get(record.name) ?? []), record]);
  const winners = new Map<string, DefinitionRecord>();
  for (const [name, definitions] of grouped) {
    definitions.sort((left, right) => (
      right.priority - left.priority || compareText(left.file.entry.logical_path, right.file.entry.logical_path)
    ));
    const winner = definitions[0];
    const sameTier = definitions.filter((record) => record.priority === winner.priority);
    if (sameTier.length > 1) {
      for (const record of sameTier) {
        record.file.outcome = "unparsed";
        addLegacyImportDiagnosis(
          diagnoses, record.file, "ambiguous-workflow-definition", "blocker",
          "Two workflow definitions at the same precedence tier share one name and require a user choice.", "requires-user",
        );
      }
      continue;
    }
    winners.set(name, winner);
    preserveDefinition(winner, candidates);
    for (const lower of definitions.slice(1)) lowerPrecedenceDiagnosis(lower, diagnoses);
    if (winner.tier === "current" && bundledNames.includes(name)) {
      const title = winner.file.kind === "markdown"
        ? markdownTitle(winner.file)
        : definitionName(winner.semantic);
      const span = title === undefined ? undefined : textSpan(winner.file, title);
      addLegacyImportDiagnosis(
        diagnoses, winner.file, "lower-precedence-workflow-shadowed", "info",
        "The project workflow deterministically shadows the bundled workflow with the same name.", "preserved",
        span?.start, span?.end,
      );
    }
  }
  return winners;
}

function runRecords(files: readonly SourceFile[]): RunRecord[] {
  const grouped = new Map<string, RunRecord>();
  for (const file of files) {
    const match = RUN_PATH.exec(file.entry.logical_path);
    if (match === null) continue;
    const key = `${match[1]}\0${match[2]}`;
    const record = grouped.get(key) ?? { workflow: match[1], runId: match[2] };
    if (match[3] === "DEFINITION.yaml") record.definition = file;
    else if (match[3] === "GRAPH.yaml") record.graph = file;
    else record.params = file;
    grouped.set(key, record);
  }
  return [...grouped.values()].sort((left, right) => (
    compareText(left.workflow, right.workflow) || compareText(left.runId, right.runId)
  ));
}

function markRunFile(file: SourceFile): void {
  file.parserId = "gsd-workflow-run-graph";
  file.parserVersion = "1";
  file.kind = file.entry.logical_path.endsWith(".json") ? "json" : "yaml";
}

function hasSupportedRunEncoding(file: SourceFile, diagnoses: PendingDiagnosis[]): boolean {
  if (file.encoding === "utf-8") return true;
  file.outcome = "unparsed";
  addLegacyImportDiagnosis(
    diagnoses, file, "unsupported-workflow-run-encoding", "warning",
    "Workflow run artifacts must be valid UTF-8 and remain retained without interpretation.", "preserved",
  );
  return false;
}

function preserveRunFile(file: SourceFile, candidates: PendingCandidate[]): void {
  file.outcome = "preserved";
  addLegacyImportCandidate(
    candidates,
    file,
    { kind: "legacy-workflow-run-artifact", key: file.entry.logical_path },
    { path: file.entry.logical_path, preservation: "verbatim" },
    "workflow-run-is-evidence-only",
    0,
    file.bytes.length,
    "preserve",
  );
}

function parseFrozenDefinition(file: SourceFile, diagnoses: PendingDiagnosis[]): unknown | undefined {
  markRunFile(file);
  if (!hasSupportedRunEncoding(file, diagnoses)) return undefined;
  let parsed: unknown;
  try {
    parsed = parseYaml(file.text, { schema: "core" });
  } catch {
    file.outcome = "unparsed";
    const span = lastContentLineSpan(file);
    addLegacyImportDiagnosis(
      diagnoses, file, "malformed-workflow-definition", "warning",
      "The frozen workflow definition is malformed and remains retained without interpretation.", "preserved",
      span.start, span.end,
    );
    return undefined;
  }
  if (!validateDefinition(parsed).valid) {
    file.outcome = "unparsed";
    const version = isRecord(parsed) ? parsed.version : undefined;
    const span = textSpan(file, `version: ${String(version)}`) ?? lastContentLineSpan(file);
    addLegacyImportDiagnosis(
      diagnoses, file, "unsupported-workflow-definition-version", "warning",
      "The frozen workflow definition is not valid under the V1 schema.", "preserved",
      span.start, span.end,
    );
    return undefined;
  }
  return parsed;
}

function parseGraph(file: SourceFile, diagnoses: PendingDiagnosis[]): boolean {
  markRunFile(file);
  if (!hasSupportedRunEncoding(file, diagnoses)) return false;
  let parsed: unknown;
  try {
    parsed = parseYaml(file.text, { schema: "core" });
  } catch {
    parsed = undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.steps) || parsed.steps.some((step) => !isRecord(step))) {
    file.outcome = "unparsed";
    const span = lastContentLineSpan(file);
    addLegacyImportDiagnosis(
      diagnoses, file, "malformed-workflow-graph", "warning",
      "The run graph is malformed and is retained without replay or repair.", "preserved",
      span.start, span.end,
    );
    return false;
  }
  const unknownStatus = parsed.steps.map((step) => step.status)
    .find((status) => !["pending", "active", "complete", "expanded"].includes(String(status)));
  if (unknownStatus !== undefined) {
    file.outcome = "unparsed";
    const span = textSpan(file, String(unknownStatus));
    addLegacyImportDiagnosis(
      diagnoses, file, "unknown-workflow-step-status", "warning",
      "The graph contains an unsupported step status and is retained without resuming the run.", "preserved",
      span?.start, span?.end,
    );
    return false;
  }
  return true;
}

function pointerToken(value: string): string {
  return value.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

function sensitiveJsonPointer(value: unknown, pointer = ""): string | undefined {
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      const found = sensitiveJsonPointer(child, `${pointer}/${index}`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const [key, child] of Object.entries(value)) {
    const childPointer = `${pointer}/${pointerToken(key)}`;
    if (SENSITIVE_KEY.test(key) && typeof child === "string" && child.length > 0) return childPointer;
    const found = sensitiveJsonPointer(child, childPointer);
    if (found !== undefined) return found;
  }
  return undefined;
}

function diagnoseSensitiveParameter(
  file: SourceFile,
  document: LegacyImportJsonDocument,
  pointer: string,
  diagnoses: PendingDiagnosis[],
): void {
  const token = document.locate(pointer);
  const locator = {
    start_byte: token.start_byte,
    end_byte: token.end_byte,
    line: lineAtByte(file, token.start_byte),
    json_pointer: pointer,
  };
  const rawValue = {
    redacted: true,
    sha256: hashLegacyImportBytes(file.bytes.subarray(token.start_byte, token.end_byte)),
  } as const;
  const identity = {
    code: "sensitive-workflow-parameter",
    severity: "warning" as const,
    source_id: file.entry.source_id,
    locator,
    raw_value: rawValue,
    message: "A synthetic secret-like workflow parameter is fingerprinted exactly and omitted from diagnostic text.",
  };
  diagnoses.push({
    diagnosis_id: hashLegacyImportValue(identity),
    ...identity,
    resolution: { disposition: "preserved" },
  });
}

function differingPrompt(frozen: unknown, current: unknown): string | undefined {
  if (!isRecord(frozen) || !isRecord(current) || !Array.isArray(frozen.steps) || !Array.isArray(current.steps)) return undefined;
  const currentById = new Map(current.steps.filter(isRecord).map((step) => [step.id, step]));
  for (const step of frozen.steps.filter(isRecord)) {
    const currentStep = currentById.get(step.id);
    if (typeof step.prompt === "string" && currentStep?.prompt !== step.prompt) return step.prompt;
  }
  return undefined;
}

function parseParams(file: SourceFile, candidates: PendingCandidate[], diagnoses: PendingDiagnosis[]): void {
  markRunFile(file);
  if (!hasSupportedRunEncoding(file, diagnoses)) return;
  let document: LegacyImportJsonDocument;
  try {
    document = parseLegacyImportJson(file.bytes);
  } catch {
    file.outcome = "unparsed";
    addLegacyImportDiagnosis(
      diagnoses, file, "malformed-workflow-parameters", "warning",
      "The workflow parameters are malformed and remain retained without interpretation.", "preserved",
    );
    return;
  }
  if (!isRecord(document.value)) {
    file.outcome = "unparsed";
    addLegacyImportDiagnosis(
      diagnoses, file, "malformed-workflow-parameters", "warning",
      "The workflow parameters must be a JSON object and remain retained without interpretation.", "preserved",
    );
    return;
  }
  preserveRunFile(file, candidates);
  const pointer = sensitiveJsonPointer(document.value);
  if (pointer !== undefined) diagnoseSensitiveParameter(file, document, pointer, diagnoses);
}

function interpretRuns(
  files: readonly SourceFile[],
  winners: ReadonlyMap<string, DefinitionRecord>,
  candidates: PendingCandidate[],
  diagnoses: PendingDiagnosis[],
): void {
  for (const run of runRecords(files)) {
    const frozen = run.definition === undefined ? undefined : parseFrozenDefinition(run.definition, diagnoses);
    if (run.definition !== undefined && frozen !== undefined) preserveRunFile(run.definition, candidates);
    if (run.graph !== undefined && parseGraph(run.graph, diagnoses)) preserveRunFile(run.graph, candidates);
    if (run.params !== undefined) parseParams(run.params, candidates, diagnoses);
    if (run.definition !== undefined && run.graph === undefined) {
      const name = definitionName(frozen);
      const span = name === undefined ? undefined : lineSpan(run.definition, `name: ${name}`);
      addLegacyImportDiagnosis(
        diagnoses, run.definition, "missing-workflow-graph", "warning",
        "The run has a frozen definition but no GRAPH.yaml; it remains evidence-only.", "preserved",
        span?.start, span?.end,
      );
    }
    const current = winners.get(run.workflow)?.semantic;
    if (run.definition !== undefined && frozen !== undefined && current !== undefined
      && hashLegacyImportValue(frozen) !== hashLegacyImportValue(current)) {
      const prompt = differingPrompt(frozen, current);
      const span = prompt === undefined ? undefined : textSpan(run.definition, prompt);
      addLegacyImportDiagnosis(
        diagnoses, run.definition, "workflow-definition-drift", "warning",
        "The frozen run definition differs from the current workflow definition; both are retained without choosing a resume path.", "preserved",
        span?.start, span?.end,
      );
    }
  }
}

export function interpretLegacyGsdWorkflows(
  files: readonly SourceFile[],
  candidates: PendingCandidate[],
  diagnoses: PendingDiagnosis[],
  context: LegacyGsdWorkflowInterpretationContext = {},
): void {
  const winners = resolveDefinitions(files, candidates, diagnoses, context.bundledDefinitionNames ?? []);
  interpretRuns(files, winners, candidates, diagnoses);
}
