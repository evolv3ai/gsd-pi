// Project/App: gsd-pi
// File Purpose: Race-aware, no-follow byte capture for legacy import Preview sources.
// Trust model: declared roots are cooperative local inputs. Double capture and
// identity checks reject ordinary drift; Node cannot provide portable openat
// traversal against a hostile process coordinating path-swap/restore attacks.

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";

import type { LegacyImportSha256 } from "./legacy-import-contract.js";
import { hashLegacyImportBytes, hashLegacyImportValue } from "./legacy-import-preview.js";

const SOURCE_CAPTURE_VERSION = 1;
const ROOT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export type LegacyImportSourceRootKind = "project" | "external" | "worktree";
export type LegacyImportSourceRootPresence = "required" | "optional";
export type LegacyImportSourceEntryKind = "directory" | "file" | "symlink";

export interface LegacyImportSourceRoot {
  id: string;
  kind: LegacyImportSourceRootKind;
  physical_path: string;
  logical_path: string;
  presence: LegacyImportSourceRootPresence;
}

export interface LegacyImportSourceCaptureInput {
  roots: readonly LegacyImportSourceRoot[];
}

export interface LegacyImportSourceCapturedRoot extends LegacyImportSourceRoot {
  observed: "present" | "absent";
  physical_identity?: string;
  real_path?: string;
}

export interface LegacyImportSourceEntry {
  root_id: string;
  source_id: LegacyImportSha256;
  logical_path: string;
  kind: LegacyImportSourceEntryKind;
  physical_identity: string;
  payload_id?: LegacyImportSha256;
  byte_size?: number;
  sha256?: LegacyImportSha256;
  symlink_target_identity?: string;
}

export interface LegacyImportSourcePayload {
  payload_id: LegacyImportSha256;
  kind: "file" | "symlink";
  byte_size: number;
  sha256: LegacyImportSha256;
  bytes_base64: string;
}

export interface LegacyImportSourceCapture {
  capture_version: typeof SOURCE_CAPTURE_VERSION;
  roots: readonly LegacyImportSourceCapturedRoot[];
  entries: readonly LegacyImportSourceEntry[];
  payloads: readonly LegacyImportSourcePayload[];
  capture_hash: LegacyImportSha256;
}

export interface LegacyImportSourceTestEvent {
  root_id: string;
  logical_path: string;
  physical_path: string;
}

export interface LegacyImportSourceTestHooks {
  after_directory_read?(event: LegacyImportSourceTestEvent): void;
  after_file_inspect?(event: LegacyImportSourceTestEvent): void;
  after_file_read?(event: LegacyImportSourceTestEvent): void;
  after_symlink_read?(event: LegacyImportSourceTestEvent): void;
  after_initial_capture?(event: { capture_hash: LegacyImportSha256 }): void;
}

export type LegacyImportSourceErrorStage = "capture" | "revalidate";

export class LegacyImportSourceError extends Error {
  readonly stage: LegacyImportSourceErrorStage;
  readonly code: string;
  readonly retryable: boolean;
  readonly context: Readonly<Record<string, string>>;

  constructor(
    stage: LegacyImportSourceErrorStage,
    code: string,
    message: string,
    retryable: boolean,
    context: Record<string, string> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LegacyImportSourceError";
    this.stage = stage;
    this.code = code;
    this.retryable = retryable;
    this.context = Object.freeze({ ...context });
  }
}

interface PresentRoot extends LegacyImportSourceRoot {
  stat: BigIntStats;
  physical_identity: string;
  real_path: string;
}

interface AllowedTargetRoot {
  kind: "directory" | "file";
  real_path: string;
}

interface CaptureState {
  hooks: LegacyImportSourceTestHooks;
  allowedTargets: readonly AllowedTargetRoot[];
  entries: LegacyImportSourceEntry[];
  payloads: LegacyImportSourcePayload[];
  filePayloads: Map<string, CapturedFilePayload>;
  symlinkPayloads: Map<string, LegacyImportSourcePayload>;
}

interface CapturedFilePayload {
  payload: LegacyImportSourcePayload;
  stable_stat: string;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function sourceError(
  code: string,
  message: string,
  retryable: boolean,
  context: Record<string, string> = {},
  cause?: unknown,
): LegacyImportSourceError {
  return new LegacyImportSourceError("capture", code, message, retryable, context, { cause });
}

function systemErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function rootContext(root: LegacyImportSourceRoot, operation?: string): Record<string, string> {
  return {
    root_id: root.id,
    logical_path: root.logical_path,
    ...(operation === undefined ? {} : { operation }),
  };
}

function entryContext(
  root: LegacyImportSourceRoot,
  logicalPath: string,
  operation?: string,
): Record<string, string> {
  return {
    root_id: root.id,
    logical_path: logicalPath,
    ...(operation === undefined ? {} : { operation }),
  };
}

function requireValidLogicalPath(value: string): void {
  if (
    value.length === 0
    || value.includes("\0")
    || value.includes("\\")
    || posix.isAbsolute(value)
  ) {
    throw sourceError(
      "LEGACY_IMPORT_SOURCE_ROOT_INVALID",
      "legacy import source logical paths must be non-empty relative POSIX paths",
      false,
      { logical_path: value },
    );
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw sourceError(
      "LEGACY_IMPORT_SOURCE_ROOT_INVALID",
      "legacy import source logical paths must be canonical",
      false,
      { logical_path: value },
    );
  }
}

function validateRoots(input: LegacyImportSourceCaptureInput): LegacyImportSourceRoot[] {
  if (!Array.isArray(input.roots) || input.roots.length === 0) {
    throw sourceError(
      "LEGACY_IMPORT_SOURCE_ROOT_INVALID",
      "legacy import source capture requires at least one explicit root",
      false,
    );
  }
  const roots = input.roots.map((candidate) => ({
    id: candidate.id,
    kind: candidate.kind,
    physical_path: candidate.physical_path,
    logical_path: candidate.logical_path,
    presence: candidate.presence,
  }));
  const ids = new Set<string>();
  const logicalPaths: string[] = [];
  for (const root of roots) {
    if (!ROOT_ID_PATTERN.test(root.id) || ids.has(root.id)) {
      throw sourceError(
        "LEGACY_IMPORT_SOURCE_ROOT_INVALID",
        "legacy import source root IDs must be unique canonical slugs",
        false,
        rootContext(root),
      );
    }
    ids.add(root.id);
    if (!(["project", "external", "worktree"] as const).includes(root.kind)) {
      throw sourceError(
        "LEGACY_IMPORT_SOURCE_ROOT_INVALID",
        "legacy import source root kind is invalid",
        false,
        rootContext(root),
      );
    }
    if (root.presence !== "required" && root.presence !== "optional") {
      throw sourceError(
        "LEGACY_IMPORT_SOURCE_ROOT_INVALID",
        "legacy import source root presence is invalid",
        false,
        rootContext(root),
      );
    }
    if (
      root.physical_path.includes("\0")
      || !isAbsolute(root.physical_path)
      || resolve(root.physical_path) !== root.physical_path
    ) {
      throw sourceError(
        "LEGACY_IMPORT_SOURCE_ROOT_INVALID",
        "legacy import source physical paths must be canonical absolute paths",
        false,
        rootContext(root),
      );
    }
    requireValidLogicalPath(root.logical_path);
    if (logicalPaths.some((existing) => (
      root.logical_path === existing
      || root.logical_path.startsWith(`${existing}/`)
      || existing.startsWith(`${root.logical_path}/`)
    ))) {
      throw sourceError(
        "LEGACY_IMPORT_SOURCE_ROOT_INVALID",
        "legacy import source logical roots must not overlap",
        false,
        rootContext(root),
      );
    }
    logicalPaths.push(root.logical_path);
  }
  roots.sort((left, right) => compareText(left.id, right.id));
  return roots;
}

function identity(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}`;
}

function stableStat(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs]
    .map((value) => value.toString())
    .join(":");
}

function safeByteSize(size: bigint, context: Record<string, string>): number {
  const value = Number(size);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw sourceError(
      "LEGACY_IMPORT_SOURCE_UNSUPPORTED",
      "legacy import source is too large to capture safely",
      false,
      context,
    );
  }
  return value;
}

function initialLstat(root: LegacyImportSourceRoot): BigIntStats | undefined {
  try {
    return lstatSync(root.physical_path, { bigint: true });
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT" && root.presence === "optional") return undefined;
    const unavailable = systemErrorCode(error) === "ENOENT" || systemErrorCode(error) === "ENOTDIR";
    throw sourceError(
      unavailable ? "LEGACY_IMPORT_SOURCE_UNAVAILABLE" : "LEGACY_IMPORT_SOURCE_UNREADABLE",
      `legacy import source root ${unavailable ? "is unavailable" : "cannot be inspected"}`,
      unavailable,
      rootContext(root, "lstat"),
      error,
    );
  }
}

function resolveRealPath(root: LegacyImportSourceRoot, logicalPath: string, physicalPath: string): string {
  try {
    return realpathSync.native(physicalPath);
  } catch (error) {
    const unavailable = systemErrorCode(error) === "ENOENT" || systemErrorCode(error) === "ENOTDIR";
    throw sourceError(
      unavailable ? "LEGACY_IMPORT_SOURCE_UNAVAILABLE" : "LEGACY_IMPORT_SOURCE_UNREADABLE",
      `legacy import source ${unavailable ? "target is unavailable" : "real path cannot be resolved"}`,
      unavailable,
      entryContext(root, logicalPath, "realpath"),
      error,
    );
  }
}

function pinRoots(roots: readonly LegacyImportSourceRoot[]): {
  captured: LegacyImportSourceCapturedRoot[];
  present: PresentRoot[];
  allowedTargets: AllowedTargetRoot[];
} {
  const captured: LegacyImportSourceCapturedRoot[] = [];
  const present: PresentRoot[] = [];
  for (const root of roots) {
    const stat = initialLstat(root);
    if (stat === undefined) {
      captured.push({ ...root, observed: "absent" });
      continue;
    }
    const realPath = resolveRealPath(root, root.logical_path, root.physical_path);
    const pinned: PresentRoot = {
      ...root,
      stat,
      physical_identity: identity(stat),
      real_path: realPath,
    };
    present.push(pinned);
    captured.push({
      ...root,
      observed: "present",
      physical_identity: pinned.physical_identity,
      real_path: realPath,
    });
  }
  const allowedTargets: AllowedTargetRoot[] = [];
  for (const root of present) {
    if (root.stat.isDirectory()) allowedTargets.push({ kind: "directory", real_path: root.real_path });
    if (root.stat.isFile()) allowedTargets.push({ kind: "file", real_path: root.real_path });
  }
  return { captured, present, allowedTargets };
}

function logicalChild(parent: string, name: string): string {
  return `${parent}/${name}`;
}

function sourceId(root: LegacyImportSourceRoot, logicalPath: string): LegacyImportSha256 {
  return hashLegacyImportValue({
    source_capture_version: SOURCE_CAPTURE_VERSION,
    root_kind: root.kind,
    logical_path: logicalPath,
  });
}

function payloadId(kind: "file" | "symlink", physicalIdentity: string): LegacyImportSha256 {
  return hashLegacyImportValue({
    source_capture_version: SOURCE_CAPTURE_VERSION,
    kind,
    physical_identity: physicalIdentity,
  });
}

function testEvent(
  root: LegacyImportSourceRoot,
  logicalPath: string,
  physicalPath: string,
): LegacyImportSourceTestEvent {
  return { root_id: root.id, logical_path: logicalPath, physical_path: physicalPath };
}

function ensureUnchanged(
  before: BigIntStats,
  root: LegacyImportSourceRoot,
  logicalPath: string,
  physicalPath: string,
  operation: string,
): BigIntStats {
  let after: BigIntStats;
  try {
    after = lstatSync(physicalPath, { bigint: true });
  } catch (error) {
    throw sourceError(
      "LEGACY_IMPORT_SOURCE_CAPTURE_CHANGED",
      "legacy import source changed while it was being captured",
      true,
      entryContext(root, logicalPath, operation),
      error,
    );
  }
  if (stableStat(before) !== stableStat(after)) {
    throw sourceError(
      "LEGACY_IMPORT_SOURCE_CAPTURE_CHANGED",
      "legacy import source changed while it was being captured",
      true,
      entryContext(root, logicalPath, operation),
    );
  }
  return after;
}

function ensureParentUnchanged(
  root: LegacyImportSourceRoot,
  logicalPath: string,
  physicalPath: string,
  expectedIdentity: string,
): void {
  const parentPath = dirname(physicalPath);
  let currentIdentity: string;
  try {
    const realParent = realpathSync.native(parentPath);
    currentIdentity = identity(lstatSync(realParent, { bigint: true }));
  } catch (error) {
    throw sourceError(
      "LEGACY_IMPORT_SOURCE_CAPTURE_CHANGED",
      "legacy import source parent changed during traversal",
      true,
      entryContext(root, logicalPath, "validate-parent"),
      error,
    );
  }
  if (currentIdentity !== expectedIdentity) {
    throw sourceError(
      "LEGACY_IMPORT_SOURCE_CAPTURE_CHANGED",
      "legacy import source parent changed during traversal",
      true,
      entryContext(root, logicalPath, "validate-parent"),
    );
  }
}

function readNames(root: LegacyImportSourceRoot, logicalPath: string, physicalPath: string): string[] {
  try {
    return readdirSync(physicalPath).sort(compareText);
  } catch (error) {
    const changed = ["ENOENT", "ENOTDIR"].includes(systemErrorCode(error) ?? "");
    throw sourceError(
      changed ? "LEGACY_IMPORT_SOURCE_CAPTURE_CHANGED" : "LEGACY_IMPORT_SOURCE_UNREADABLE",
      changed
        ? "legacy import source directory changed while it was being captured"
        : "legacy import source directory cannot be read",
      changed,
      entryContext(root, logicalPath, "readdir"),
      error,
    );
  }
}

function captureDirectory(
  state: CaptureState,
  root: LegacyImportSourceRoot,
  logicalPath: string,
  physicalPath: string,
  stat: BigIntStats,
): void {
  state.entries.push({
    root_id: root.id,
    source_id: sourceId(root, logicalPath),
    logical_path: logicalPath,
    kind: "directory",
    physical_identity: identity(stat),
  });
  const names = readNames(root, logicalPath, physicalPath);
  state.hooks.after_directory_read?.(testEvent(root, logicalPath, physicalPath));
  for (const name of names) {
    captureEntry(
      state,
      root,
      logicalChild(logicalPath, name),
      `${physicalPath}${sep}${name}`,
      undefined,
      identity(stat),
    );
  }
  const finalNames = readNames(root, logicalPath, physicalPath);
  ensureUnchanged(stat, root, logicalPath, physicalPath, "revalidate-directory");
  if (names.length !== finalNames.length || names.some((name, index) => name !== finalNames[index])) {
    throw sourceError(
      "LEGACY_IMPORT_SOURCE_CAPTURE_CHANGED",
      "legacy import source directory changed while it was being captured",
      true,
      entryContext(root, logicalPath, "revalidate-directory"),
    );
  }
}

function readRegularFile(
  root: LegacyImportSourceRoot,
  logicalPath: string,
  physicalPath: string,
  inspected: BigIntStats,
  hooks: LegacyImportSourceTestHooks,
): Buffer {
  hooks.after_file_inspect?.(testEvent(root, logicalPath, physicalPath));
  let descriptor: number;
  try {
    descriptor = openSync(physicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const changed = ["ELOOP", "ENOENT", "ENOTDIR"].includes(systemErrorCode(error) ?? "");
    throw sourceError(
      changed ? "LEGACY_IMPORT_SOURCE_CAPTURE_CHANGED" : "LEGACY_IMPORT_SOURCE_UNREADABLE",
      changed
        ? "legacy import source changed before it could be opened"
        : "legacy import source file cannot be opened",
      changed,
      entryContext(root, logicalPath, "open"),
      error,
    );
  }
  let result: Buffer;
  try {
    let opened: BigIntStats;
    try {
      opened = fstatSync(descriptor, { bigint: true });
    } catch (error) {
      throw sourceError(
        "LEGACY_IMPORT_SOURCE_CAPTURE_CHANGED",
        "legacy import source changed before it could be read",
        true,
        entryContext(root, logicalPath, "fstat-before-read"),
        error,
      );
    }
    if (!opened.isFile() || stableStat(inspected) !== stableStat(opened)) {
      throw sourceError(
        "LEGACY_IMPORT_SOURCE_CAPTURE_CHANGED",
        "legacy import source changed before it could be read",
        true,
        entryContext(root, logicalPath, "fstat-before-read"),
      );
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(descriptor);
    } catch (error) {
      throw sourceError(
        "LEGACY_IMPORT_SOURCE_UNREADABLE",
        "legacy import source file cannot be read",
        false,
        entryContext(root, logicalPath, "read"),
        error,
      );
    }
    hooks.after_file_read?.(testEvent(root, logicalPath, physicalPath));
    let finished: BigIntStats;
    try {
      finished = fstatSync(descriptor, { bigint: true });
    } catch (error) {
      throw sourceError(
        "LEGACY_IMPORT_SOURCE_CAPTURE_CHANGED",
        "legacy import source changed while it was being read",
        true,
        entryContext(root, logicalPath, "fstat-after-read"),
        error,
      );
    }
    if (stableStat(opened) !== stableStat(finished)) {
      throw sourceError(
        "LEGACY_IMPORT_SOURCE_CAPTURE_CHANGED",
        "legacy import source changed while it was being read",
        true,
        entryContext(root, logicalPath, "fstat-after-read"),
      );
    }
    ensureUnchanged(finished, root, logicalPath, physicalPath, "lstat-after-read");
    result = bytes;
  } catch (error) {
    try {
      closeSync(descriptor);
    } catch {
      // Preserve the primary typed capture failure.
    }
    throw error;
  }
  try {
    closeSync(descriptor);
  } catch (error) {
    throw sourceError(
      "LEGACY_IMPORT_SOURCE_UNREADABLE",
      "legacy import source file descriptor cannot be closed",
      false,
      entryContext(root, logicalPath, "close"),
      error,
    );
  }
  return result;
}

function captureFile(
  state: CaptureState,
  root: LegacyImportSourceRoot,
  logicalPath: string,
  physicalPath: string,
  stat: BigIntStats,
): void {
  const physicalIdentity = identity(stat);
  let captured = state.filePayloads.get(physicalIdentity);
  if (captured === undefined) {
    const bytes = readRegularFile(root, logicalPath, physicalPath, stat, state.hooks);
    const payload: LegacyImportSourcePayload = {
      payload_id: payloadId("file", physicalIdentity),
      kind: "file",
      byte_size: safeByteSize(stat.size, entryContext(root, logicalPath)),
      sha256: hashLegacyImportBytes(bytes),
      bytes_base64: bytes.toString("base64"),
    };
    captured = { payload, stable_stat: stableStat(stat) };
    state.filePayloads.set(physicalIdentity, captured);
    state.payloads.push(payload);
  } else {
    ensureUnchanged(stat, root, logicalPath, physicalPath, "lstat-hardlink-alias");
    if (stableStat(stat) !== captured.stable_stat) {
      throw sourceError(
        "LEGACY_IMPORT_SOURCE_CAPTURE_CHANGED",
        "legacy import source hardlink changed after its payload was captured",
        true,
        entryContext(root, logicalPath, "validate-hardlink-alias"),
      );
    }
  }
  const { payload } = captured;
  state.entries.push({
    root_id: root.id,
    source_id: sourceId(root, logicalPath),
    logical_path: logicalPath,
    kind: "file",
    physical_identity: physicalIdentity,
    payload_id: payload.payload_id,
    byte_size: payload.byte_size,
    sha256: payload.sha256,
  });
}

function targetIsAllowed(target: string, allowedRoots: readonly AllowedTargetRoot[]): boolean {
  return allowedRoots.some((root) => {
    if (root.kind === "file") return target === root.real_path;
    const pathFromRoot = relative(root.real_path, target);
    return pathFromRoot === "" || (
      !isAbsolute(pathFromRoot)
      && !pathFromRoot.startsWith(`..${sep}`)
      && pathFromRoot !== ".."
    );
  });
}

function capturedSymlinkTargetPath(
  root: LegacyImportSourceRoot,
  logicalPath: string,
  physicalPath: string,
  bytes: Buffer,
): string {
  const targetText = bytes.toString("utf8");
  if (targetText.includes("\0") || !Buffer.from(targetText, "utf8").equals(bytes)) {
    throw sourceError(
      "LEGACY_IMPORT_SOURCE_UNSUPPORTED",
      "legacy import source symlink targets must be valid UTF-8 paths",
      false,
      entryContext(root, logicalPath, "decode-symlink-target"),
    );
  }
  return isAbsolute(targetText) ? resolve(targetText) : resolve(dirname(physicalPath), targetText);
}

function captureSymlink(
  state: CaptureState,
  root: LegacyImportSourceRoot,
  logicalPath: string,
  physicalPath: string,
  stat: BigIntStats,
): void {
  let bytes: Buffer;
  try {
    bytes = readlinkSync(physicalPath, { encoding: "buffer" });
  } catch (error) {
    throw sourceError(
      "LEGACY_IMPORT_SOURCE_CAPTURE_CHANGED",
      "legacy import source symlink changed while it was being read",
      true,
      entryContext(root, logicalPath, "readlink"),
      error,
    );
  }
  state.hooks.after_symlink_read?.(testEvent(root, logicalPath, physicalPath));
  const capturedTargetPath = capturedSymlinkTargetPath(root, logicalPath, physicalPath, bytes);
  const target = resolveRealPath(root, logicalPath, capturedTargetPath);
  if (!targetIsAllowed(target, state.allowedTargets)) {
    throw sourceError(
      "LEGACY_IMPORT_SOURCE_ESCAPE",
      "legacy import source symlink resolves outside the declared roots",
      false,
      entryContext(root, logicalPath, "validate-symlink-target"),
    );
  }
  let targetStat: BigIntStats;
  try {
    targetStat = lstatSync(target, { bigint: true });
  } catch (error) {
    throw sourceError(
      "LEGACY_IMPORT_SOURCE_UNAVAILABLE",
      "legacy import source symlink target is unavailable",
      true,
      entryContext(root, logicalPath, "lstat-symlink-target"),
      error,
    );
  }
  ensureUnchanged(stat, root, logicalPath, physicalPath, "lstat-after-readlink");
  let confirmedBytes: Buffer;
  try {
    confirmedBytes = readlinkSync(physicalPath, { encoding: "buffer" });
  } catch (error) {
    throw sourceError(
      "LEGACY_IMPORT_SOURCE_CAPTURE_CHANGED",
      "legacy import source symlink changed while it was being confirmed",
      true,
      entryContext(root, logicalPath, "confirm-readlink"),
      error,
    );
  }
  if (!confirmedBytes.equals(bytes)) {
    throw sourceError(
      "LEGACY_IMPORT_SOURCE_CAPTURE_CHANGED",
      "legacy import source symlink changed while it was being confirmed",
      true,
      entryContext(root, logicalPath, "confirm-readlink"),
    );
  }
  const physicalIdentity = identity(stat);
  let payload = state.symlinkPayloads.get(physicalIdentity);
  if (payload === undefined) {
    payload = {
      payload_id: payloadId("symlink", physicalIdentity),
      kind: "symlink",
      byte_size: bytes.byteLength,
      sha256: hashLegacyImportBytes(bytes),
      bytes_base64: bytes.toString("base64"),
    };
    state.symlinkPayloads.set(physicalIdentity, payload);
    state.payloads.push(payload);
  } else if (payload.bytes_base64 !== bytes.toString("base64")) {
    throw sourceError(
      "LEGACY_IMPORT_SOURCE_CAPTURE_CHANGED",
      "legacy import source symlink changed after its payload was captured",
      true,
      entryContext(root, logicalPath, "validate-symlink-alias"),
    );
  }
  state.entries.push({
    root_id: root.id,
    source_id: sourceId(root, logicalPath),
    logical_path: logicalPath,
    kind: "symlink",
    physical_identity: physicalIdentity,
    payload_id: payload.payload_id,
    byte_size: payload.byte_size,
    sha256: payload.sha256,
    symlink_target_identity: identity(targetStat),
  });
}

function captureEntry(
  state: CaptureState,
  root: LegacyImportSourceRoot,
  logicalPath: string,
  physicalPath: string,
  knownStat?: BigIntStats,
  expectedParentIdentity?: string,
): void {
  if (expectedParentIdentity !== undefined) {
    ensureParentUnchanged(root, logicalPath, physicalPath, expectedParentIdentity);
  }
  let stat = knownStat;
  if (stat === undefined) {
    try {
      stat = lstatSync(physicalPath, { bigint: true });
    } catch (error) {
      throw sourceError(
        "LEGACY_IMPORT_SOURCE_CAPTURE_CHANGED",
        "legacy import source changed during directory traversal",
        true,
        entryContext(root, logicalPath, "lstat"),
        error,
      );
    }
  }
  if (stat.isDirectory()) {
    captureDirectory(state, root, logicalPath, physicalPath, stat);
    return;
  }
  if (stat.isFile()) {
    captureFile(state, root, logicalPath, physicalPath, stat);
    return;
  }
  if (stat.isSymbolicLink()) {
    captureSymlink(state, root, logicalPath, physicalPath, stat);
    return;
  }
  throw sourceError(
    "LEGACY_IMPORT_SOURCE_UNSUPPORTED",
    "legacy import source contains an unsupported filesystem entry",
    false,
    entryContext(root, logicalPath, "classify"),
  );
}

function captureLegacyImportSourceSetInternal(
  input: LegacyImportSourceCaptureInput,
  hooks: LegacyImportSourceTestHooks,
): LegacyImportSourceCapture {
  const roots = validateRoots(input);
  const pinned = pinRoots(roots);
  const state: CaptureState = {
    hooks,
    allowedTargets: pinned.allowedTargets,
    entries: [],
    payloads: [],
    filePayloads: new Map(),
    symlinkPayloads: new Map(),
  };
  for (const root of pinned.present) {
    captureEntry(state, root, root.logical_path, root.physical_path, root.stat);
  }
  state.entries.sort((left, right) => compareText(left.logical_path, right.logical_path));
  state.payloads.sort((left, right) => compareText(left.payload_id, right.payload_id));
  const captureWithoutHash: Omit<LegacyImportSourceCapture, "capture_hash"> = {
    capture_version: SOURCE_CAPTURE_VERSION,
    roots: pinned.captured,
    entries: state.entries,
    payloads: state.payloads,
  };
  return deepFreeze({
    ...captureWithoutHash,
    capture_hash: hashLegacyImportValue(captureWithoutHash),
  });
}

export function captureLegacyImportSourceSet(
  input: LegacyImportSourceCaptureInput,
): LegacyImportSourceCapture {
  return captureStableLegacyImportSourceSet(input, {});
}

function captureStableLegacyImportSourceSet(
  input: LegacyImportSourceCaptureInput,
  hooks: LegacyImportSourceTestHooks,
): LegacyImportSourceCapture {
  const first = captureLegacyImportSourceSetInternal(input, hooks);
  hooks.after_initial_capture?.({ capture_hash: first.capture_hash });
  const confirmed = captureLegacyImportSourceSetInternal({ roots: first.roots }, {});
  if (confirmed.capture_hash !== first.capture_hash) {
    throw sourceError(
      "LEGACY_IMPORT_SOURCE_CAPTURE_CHANGED",
      "legacy import sources changed while the source set was being confirmed",
      true,
      {
        first_capture_hash: first.capture_hash,
        confirmed_capture_hash: confirmed.capture_hash,
      },
    );
  }
  return confirmed;
}

export function _captureLegacyImportSourceSetForTest(
  input: LegacyImportSourceCaptureInput,
  hooks: LegacyImportSourceTestHooks,
): LegacyImportSourceCapture {
  return captureStableLegacyImportSourceSet(input, hooks);
}

export function revalidateLegacyImportSourceSet(
  capture: LegacyImportSourceCapture,
): LegacyImportSourceCapture {
  let observed: LegacyImportSourceCapture;
  try {
    observed = captureLegacyImportSourceSet({ roots: capture.roots });
  } catch (error) {
    if (error instanceof LegacyImportSourceError && error.code === "LEGACY_IMPORT_SOURCE_CAPTURE_CHANGED") {
      throw new LegacyImportSourceError(
        "revalidate",
        error.code,
        error.message,
        error.retryable,
        { ...error.context, expected_capture_hash: capture.capture_hash },
        { cause: error },
      );
    }
    throw new LegacyImportSourceError(
      "revalidate",
      "LEGACY_IMPORT_SOURCE_CHANGED",
      "legacy import sources no longer match the captured source set",
      true,
      {
        expected_capture_hash: capture.capture_hash,
        ...(error instanceof LegacyImportSourceError ? { observed_error_code: error.code } : {}),
      },
      { cause: error },
    );
  }
  if (observed.capture_hash !== capture.capture_hash) {
    throw new LegacyImportSourceError(
      "revalidate",
      "LEGACY_IMPORT_SOURCE_CHANGED",
      "legacy import sources no longer match the captured source set",
      true,
      {
        expected_capture_hash: capture.capture_hash,
        observed_capture_hash: observed.capture_hash,
      },
    );
  }
  return observed;
}
