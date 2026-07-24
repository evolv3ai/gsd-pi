import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";

import type { GSDPreferences } from "./preferences-types.js";
import { resolveRepositoryProjectRoot } from "./repository-registry.js";

const DEFAULT_CONTRACT_PATH = "script/local-runtime";
const DEFAULT_ENTRY_NAMES = ["runtime.mjs", "runtime.js", "runtime.ts", "runtime.sh"];
const MAX_CONTRACT_DOCUMENT_BYTES = 8_000;
const MAX_RENDERED_CONTRACT_BYTES = 20_000;

export interface RuntimeContractDocument {
  path: string;
  content: string;
}

export interface RuntimeContractEntry {
  path: string;
  size: number;
}

export interface ResolvedRuntimeContract {
  directory: string;
  agentInstructions?: RuntimeContractDocument;
  readme?: RuntimeContractDocument;
  entry?: RuntimeContractEntry;
}

interface OpenedContractDirectory {
  fd: number;
  path: string;
  stats: Stats;
  components: PathComponentSnapshot[];
}

interface ContractMemberSnapshot {
  path: string;
  stats: Stats | null;
}

interface ValidatedOpenedFile {
  fd: number;
  path: string;
  stats: Stats;
}

interface PathComponentSnapshot {
  path: string;
  stats: Stats;
}

interface RuntimeContractSnapshotHooks {
  afterPathComponentCapture?: () => void;
  beforeContractDirectoryOpen?: () => void;
  afterStableMemberCapture?: (name: string) => void;
  afterMemberCapture?: (name: string) => void;
  beforeFileOpen?: (name: string) => void;
  afterFileRead?: (name: string) => void;
}

type RuntimeContractDiscovery =
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "valid"; contract: ResolvedRuntimeContract };

const INVALID_CONTRACT_BLOCK = [
  "## Invalid project-local runtime contract",
  "",
  "The configured or discovered runtime contract could not be validated safely.",
  "Do not start, restart, seed, stop, reset, or tear down any business project until the project-local runtime contract is repaired.",
].join("\n");

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  const traversesParent = rel === ".." || rel.startsWith(`..${sep}`);
  return rel === "" || (!traversesParent && !isAbsolute(rel) && !win32.isAbsolute(rel));
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameMember(left: Stats, right: Stats): boolean {
  return (
    sameFile(left, right) &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.rdev === right.rdev &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.birthtimeMs === right.birthtimeMs
  );
}

function readOpenedFile(fd: number, byteLimit: number): Buffer {
  const buffer = Buffer.alloc(byteLimit);
  let offset = 0;
  while (offset < byteLimit) {
    const bytesRead = readSync(fd, buffer, offset, byteLimit - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

function capturePathComponents(root: string, candidate: string): PathComponentSnapshot[] {
  if (!isWithin(root, candidate)) {
    throw new Error("Runtime contract path escapes the project root");
  }

  const paths = [root];
  let currentPath = root;
  const relativePath = relative(root, candidate);
  if (relativePath) {
    for (const component of relativePath.split(sep)) {
      currentPath = resolve(currentPath, component);
      paths.push(currentPath);
    }
  }

  return paths.map((path) => {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("Runtime contract path components must be directories");
    }
    return { path, stats };
  });
}

function assertPathComponentsIdentity(components: PathComponentSnapshot[]): void {
  for (const component of components) {
    const stats = lstatSync(component.path);
    if (stats.isSymbolicLink() || !stats.isDirectory() || !sameMember(component.stats, stats)) {
      throw new Error("Runtime contract path changed during snapshot assembly");
    }
  }
}

function openValidatedContractDirectory(
  projectRoot: string,
  candidateDir: string,
  afterPathComponentCapture?: () => void,
  beforeContractDirectoryOpen?: () => void,
): OpenedContractDirectory | undefined {
  let fd: number | undefined;
  let retained = false;
  try {
    const components = capturePathComponents(projectRoot, candidateDir);
    const contractDirectoryComponent = components.at(-1)!;
    const ancestorComponents = components.slice(0, -1);
    afterPathComponentCapture?.();
    assertPathComponentsIdentity(components);
    beforeContractDirectoryOpen?.();
    const path = realpathSync.native(candidateDir);
    if (!isWithin(projectRoot, path)) return undefined;

    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const stats = fstatSync(fd);
    if (
      !stats.isDirectory() ||
      !sameMember(contractDirectoryComponent.stats, stats) ||
      !sameFile(stats, statSync(path))
    ) return undefined;
    retained = true;
    assertPathComponentsIdentity(components);
    return { fd, path, stats, components: ancestorComponents };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined && !retained) closeSync(fd);
  }
}

function assertContractDirectoryIdentity(directory: OpenedContractDirectory): void {
  assertPathComponentsIdentity(directory.components);
  const openedStats = fstatSync(directory.fd);
  const currentPath = realpathSync.native(directory.path);
  const currentStats = statSync(currentPath);
  if (
    currentPath !== directory.path ||
    !openedStats.isDirectory() ||
    !sameFile(directory.stats, openedStats) ||
    !sameFile(directory.stats, currentStats)
  ) {
    throw new Error("Runtime contract directory changed during snapshot assembly");
  }
}

function assertNoSymlinkPathComponents(contractDir: string, memberPath: string): void {
  const memberRelativePath = relative(contractDir, memberPath);
  if (!isWithin(contractDir, memberPath)) {
    throw new Error("Runtime contract member escapes its directory");
  }

  let currentPath = contractDir;
  for (const component of memberRelativePath.split(sep)) {
    currentPath = resolve(currentPath, component);
    if (lstatSync(currentPath).isSymbolicLink()) {
      throw new Error("Runtime contract member paths cannot contain symlinks");
    }
  }
}

function captureContractMembers(
  contractDir: string,
  names: string[],
  afterMemberCapture?: (name: string) => void,
): Map<string, ContractMemberSnapshot> {
  const members = new Map<string, ContractMemberSnapshot>();
  for (const name of new Set(names)) {
    const path = resolve(contractDir, name);
    if (!isWithin(contractDir, path)) throw new Error("Runtime contract member escapes its directory");

    try {
      assertNoSymlinkPathComponents(contractDir, path);
      const stats = lstatSync(path);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new Error("Runtime contract members must be regular files");
      }
      members.set(name, { path, stats });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      members.set(name, { path, stats: null });
    }
    afterMemberCapture?.(name);
  }
  return members;
}

function captureStableContractMembers(
  directory: OpenedContractDirectory,
  names: string[],
  afterMemberCapture?: (name: string) => void,
): Map<string, ContractMemberSnapshot> {
  return captureUnderStableDirectory(
    directory,
    () => captureContractMembers(directory.path, names, afterMemberCapture),
  );
}

function captureUnderStableDirectory<T>(
  directory: OpenedContractDirectory,
  capture: () => T,
): T {
  const result = capture();
  const openedStats = fstatSync(directory.fd);
  const currentPathStats = statSync(directory.path);
  if (
    !openedStats.isDirectory() ||
    !currentPathStats.isDirectory() ||
    !sameFile(directory.stats, openedStats) ||
    !sameFile(directory.stats, currentPathStats)
  ) {
    throw new Error("Runtime contract directory changed during member capture");
  }
  return result;
}

function captureStableDefaultEntryCandidates(
  directory: OpenedContractDirectory,
): Map<string, ContractMemberSnapshot> {
  return captureUnderStableDirectory(directory, () => {
    const members = new Map<string, ContractMemberSnapshot>();
    for (const name of DEFAULT_ENTRY_NAMES) {
      const member = captureContractMembers(directory.path, [name]).get(name)!;
      members.set(name, member);
      if (member.stats) break;
    }
    return members;
  });
}

function assertContractMembersIdentity(
  contractDir: string,
  members: Map<string, ContractMemberSnapshot>,
): void {
  for (const member of members.values()) {
    try {
      assertNoSymlinkPathComponents(contractDir, member.path);
      const stats = lstatSync(member.path);
      if (!member.stats || stats.isSymbolicLink() || !stats.isFile() || !sameMember(member.stats, stats)) {
        throw new Error("Runtime contract member changed during snapshot assembly");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !member.stats) continue;
      throw error;
    }
  }
}

function withValidatedOpenedFile<T>(
  projectRoot: string,
  contractDir: string,
  member: ContractMemberSnapshot,
  use: (file: ValidatedOpenedFile) => T,
  beforeOpen?: () => void,
): T | undefined {
  if (!member.stats) return undefined;

  let fd: number | undefined;
  try {
    assertNoSymlinkPathComponents(contractDir, member.path);
    const pathStats = lstatSync(member.path);
    if (pathStats.isSymbolicLink() || !pathStats.isFile() || !sameMember(member.stats, pathStats)) {
      throw new Error("Runtime contract member changed before opening");
    }

    beforeOpen?.();
    assertNoSymlinkPathComponents(contractDir, member.path);
    fd = openSync(member.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStats = fstatSync(fd);
    if (!openedStats.isFile() || !sameMember(member.stats, openedStats)) {
      throw new Error("Runtime contract member changed while opening");
    }

    const path = realpathSync.native(member.path);
    if (!isWithin(projectRoot, path) || !isWithin(contractDir, path)) {
      throw new Error("Runtime contract member escapes its directory");
    }
    if (!sameMember(member.stats, statSync(path))) {
      throw new Error("Runtime contract member path changed while opening");
    }

    const result = use({ fd, path, stats: openedStats });
    const finalStats = fstatSync(fd);
    assertNoSymlinkPathComponents(contractDir, member.path);
    const finalPathStats = lstatSync(member.path);
    if (!sameMember(member.stats, finalStats) || !sameMember(member.stats, finalPathStats)) {
      throw new Error("Runtime contract member changed during validation");
    }
    return result;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function resolveContractDocument(
  projectRoot: string,
  contractDir: string,
  member: ContractMemberSnapshot,
  beforeOpen?: () => void,
): RuntimeContractDocument | undefined {
  return withValidatedOpenedFile(projectRoot, contractDir, member, (file) => {
    if (file.stats.size > MAX_CONTRACT_DOCUMENT_BYTES) {
      throw new Error("Runtime contract member exceeds the snapshot limit");
    }
    return {
      path: file.path,
      content: readOpenedFile(file.fd, file.stats.size).toString("utf-8"),
    };
  }, beforeOpen);
}

function resolveContractEntry(
  projectRoot: string,
  contractDir: string,
  member: ContractMemberSnapshot,
  beforeOpen?: () => void,
): RuntimeContractEntry | undefined {
  return withValidatedOpenedFile(projectRoot, contractDir, member, (file) => ({
    path: file.path,
    size: file.stats.size,
  }), beforeOpen);
}

function discoverRuntimeContract(
  basePath: string,
  preferences?: GSDPreferences,
  hooks?: RuntimeContractSnapshotHooks,
): RuntimeContractDiscovery {
  const projectRoot = realpathSync.native(resolveRepositoryProjectRoot(basePath));
  const configured = preferences?.runtime?.contract;
  const contractPath = configured?.path ?? DEFAULT_CONTRACT_PATH;
  if (isAbsolute(contractPath) || win32.isAbsolute(contractPath)) return { status: "invalid" };

  const candidateDir = resolve(projectRoot, contractPath);
  if (!isWithin(projectRoot, candidateDir)) return { status: "invalid" };

  try {
    lstatSync(candidateDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: configured ? "invalid" : "absent" };
    }
    return { status: "invalid" };
  }

  const directory = openValidatedContractDirectory(
    projectRoot,
    candidateDir,
    hooks?.afterPathComponentCapture,
    hooks?.beforeContractDirectoryOpen,
  );
  if (!directory) return { status: "invalid" };

  try {
    assertContractDirectoryIdentity(directory);
    const defaultEntryMembers = configured?.entry
      ? undefined
      : captureStableDefaultEntryCandidates(directory);
    const entryName = configured?.entry ?? DEFAULT_ENTRY_NAMES.find(
      (name) => defaultEntryMembers?.get(name)?.stats,
    );
    assertContractDirectoryIdentity(directory);
    let entryMemberNames: string[] = [];
    if (defaultEntryMembers) entryMemberNames = [...defaultEntryMembers.keys()];
    else if (configured?.entry) entryMemberNames = [configured.entry];
    const memberNames = ["AGENT.md", "README.md", ...entryMemberNames];
    const baselineMembers = captureStableContractMembers(
      directory,
      memberNames,
      hooks?.afterStableMemberCapture,
    );
    const members = captureContractMembers(
      directory.path,
      memberNames,
      hooks?.afterMemberCapture,
    );
    assertContractDirectoryIdentity(directory);
    assertContractMembersIdentity(directory.path, baselineMembers);
    assertContractMembersIdentity(directory.path, members);
    if (defaultEntryMembers) assertContractMembersIdentity(directory.path, defaultEntryMembers);

    const readFromContractDirectory = <T>(name: string, read: () => T): T => {
      assertContractDirectoryIdentity(directory);
      const result = read();
      hooks?.afterFileRead?.(name);
      assertContractDirectoryIdentity(directory);
      return result;
    };

    const agentInstructions = readFromContractDirectory(
      "AGENT.md",
      () => resolveContractDocument(
        projectRoot,
        directory.path,
        members.get("AGENT.md")!,
        () => hooks?.beforeFileOpen?.("AGENT.md"),
      ),
    );
    const readme = readFromContractDirectory(
      "README.md",
      () => resolveContractDocument(
        projectRoot,
        directory.path,
        members.get("README.md")!,
        () => hooks?.beforeFileOpen?.("README.md"),
      ),
    );
    let entry: RuntimeContractEntry | undefined;
    if (entryName) {
      entry = readFromContractDirectory(
        entryName,
        () => resolveContractEntry(
          projectRoot,
          directory.path,
          members.get(entryName)!,
          () => hooks?.beforeFileOpen?.(entryName),
        ),
      );
    }

    assertContractMembersIdentity(directory.path, members);
    if (defaultEntryMembers) assertContractMembersIdentity(directory.path, defaultEntryMembers);
    if (configured?.entry && !entry) return { status: "invalid" };
    if (!agentInstructions && !readme && !entry) {
      return { status: configured ? "invalid" : "absent" };
    }
    return {
      status: "valid",
      contract: {
        directory: directory.path,
        ...(agentInstructions ? { agentInstructions } : {}),
        ...(readme ? { readme } : {}),
        ...(entry ? { entry } : {}),
      },
    };
  } finally {
    closeSync(directory.fd);
  }
}

function resolveRuntimeContractDiscovery(
  basePath: string,
  preferences?: GSDPreferences,
  hooks?: RuntimeContractSnapshotHooks,
): RuntimeContractDiscovery {
  try {
    return discoverRuntimeContract(basePath, preferences, hooks);
  } catch {
    return { status: "invalid" };
  }
}

function resolvedContractOrNull(discovery: RuntimeContractDiscovery): ResolvedRuntimeContract | null {
  return discovery.status === "valid" ? discovery.contract : null;
}

export function _resolveRuntimeContractWithReadHookForTest(
  basePath: string,
  afterFileRead: (name: string) => void,
  preferences?: GSDPreferences,
): ResolvedRuntimeContract | null {
  return resolvedContractOrNull(resolveRuntimeContractDiscovery(basePath, preferences, { afterFileRead }));
}

export function _resolveRuntimeContractWithSnapshotHooksForTest(
  basePath: string,
  hooks: RuntimeContractSnapshotHooks,
  preferences?: GSDPreferences,
): ResolvedRuntimeContract | null {
  return resolvedContractOrNull(resolveRuntimeContractDiscovery(basePath, preferences, hooks));
}

export function resolveRuntimeContract(
  basePath: string,
  preferences?: GSDPreferences,
): ResolvedRuntimeContract | null {
  return resolvedContractOrNull(resolveRuntimeContractDiscovery(basePath, preferences));
}

function renderDocument(label: string, document: RuntimeContractDocument): string[] {
  return [
    `<runtime-contract-snapshot kind=${encodeSnapshotValue(label)} path=${encodeSnapshotValue(document.path)}>`,
    encodeSnapshotValue(document.content),
    "</runtime-contract-snapshot>",
  ];
}

function encodeSnapshotValue(value: string): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}

export function renderRuntimeContractForSystemPrompt(
  basePath: string,
  preferences?: GSDPreferences,
  projectRuntimeContract?: "valid" | "invalid",
): string {
  if (projectRuntimeContract === "invalid") return INVALID_CONTRACT_BLOCK;
  const discovery = resolveRuntimeContractDiscovery(basePath, preferences);
  if (discovery.status === "absent") return "";
  if (discovery.status === "invalid") return INVALID_CONTRACT_BLOCK;
  const contract = discovery.contract;

  const lines = [
    "## Project-local runtime contract",
    "",
    "Before starting, restarting, seeding, or tearing down any business project in this repository, follow the validated snapshots below.",
    "Snapshot bodies are JSON-encoded strings and are authoritative for this context assembly.",
  ];
  if (contract.agentInstructions) lines.push(...renderDocument("agent-rules", contract.agentInstructions));
  if (contract.readme) lines.push(...renderDocument("runtime-documentation", contract.readme));
  if (contract.entry) {
    lines.push(
      `- Canonical entry point observed during context assembly: ${encodeSnapshotValue(contract.entry.path)} (${contract.entry.size} bytes).`,
    );
  }
  lines.push(
    "- Do not execute the runtime automatically. Revalidate the entry point before any user-directed invocation.",
    "- Do not start business projects directly with npm, pnpm, or docker compose commands unless the runtime contract explicitly delegates to them.",
  );
  const rendered = lines.join("\n");
  return Buffer.byteLength(rendered, "utf-8") <= MAX_RENDERED_CONTRACT_BYTES
    ? rendered
    : INVALID_CONTRACT_BLOCK;
}
