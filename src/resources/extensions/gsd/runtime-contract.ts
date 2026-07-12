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
import { createRepositoryRegistryFromPreferences } from "./repository-registry.js";

const DEFAULT_CONTRACT_PATH = "script/local-runtime";
const DEFAULT_ENTRY_NAMES = ["runtime.mjs", "runtime.js", "runtime.ts", "runtime.sh"];
const MAX_CONTRACT_DOCUMENT_BYTES = 8_000;
const MAX_RENDERED_CONTRACT_BYTES = 20_000;

export interface RuntimeContractDocument {
  path: string;
  content: string;
  truncated: boolean;
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
}

interface ContractMemberSnapshot {
  path: string;
  stats: Stats | null;
}

interface RuntimeContractSnapshotHooks {
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

function openValidatedContractDirectory(
  projectRoot: string,
  candidateDir: string,
): OpenedContractDirectory | undefined {
  let fd: number | undefined;
  let retained = false;
  try {
    const path = realpathSync.native(candidateDir);
    if (!isWithin(projectRoot, path)) return undefined;

    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const stats = fstatSync(fd);
    if (!stats.isDirectory() || !sameFile(stats, statSync(path))) return undefined;
    retained = true;
    return { fd, path, stats };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined && !retained) closeSync(fd);
  }
}

function assertContractDirectoryIdentity(directory: OpenedContractDirectory): void {
  const openedStats = fstatSync(directory.fd);
  const currentPath = realpathSync.native(directory.path);
  const currentStats = statSync(currentPath);
  if (
    currentPath !== directory.path ||
    !openedStats.isDirectory() ||
    !sameMember(directory.stats, openedStats) ||
    !sameMember(directory.stats, currentStats)
  ) {
    throw new Error("Runtime contract directory changed during snapshot assembly");
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

function assertContractMembersIdentity(members: Map<string, ContractMemberSnapshot>): void {
  for (const member of members.values()) {
    try {
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

function openValidatedFile(
  projectRoot: string,
  contractDir: string,
  member: ContractMemberSnapshot,
  beforeOpen?: () => void,
): { path: string; size: number; content: Buffer } | undefined {
  if (!member.stats) return undefined;

  let fd: number | undefined;
  try {
    const pathStats = lstatSync(member.path);
    if (pathStats.isSymbolicLink() || !pathStats.isFile() || !sameMember(member.stats, pathStats)) {
      throw new Error("Runtime contract member changed before opening");
    }

    beforeOpen?.();
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

    const content = readOpenedFile(fd, Math.min(openedStats.size, MAX_CONTRACT_DOCUMENT_BYTES));
    const finalStats = fstatSync(fd);
    const finalPathStats = lstatSync(member.path);
    if (!sameMember(member.stats, finalStats) || !sameMember(member.stats, finalPathStats)) {
      throw new Error("Runtime contract member changed while reading");
    }
    return { path, size: openedStats.size, content };
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
  const file = openValidatedFile(projectRoot, contractDir, member, beforeOpen);
  if (!file) return undefined;
  return {
    path: file.path,
    content: file.content.toString("utf-8"),
    truncated: file.size > file.content.length,
  };
}

function resolveContractEntry(
  projectRoot: string,
  contractDir: string,
  member: ContractMemberSnapshot,
  beforeOpen?: () => void,
): RuntimeContractEntry | undefined {
  const file = openValidatedFile(projectRoot, contractDir, member, beforeOpen);
  return file ? { path: file.path, size: file.size } : undefined;
}

function discoverRuntimeContract(
  basePath: string,
  preferences?: GSDPreferences,
  hooks?: RuntimeContractSnapshotHooks,
): RuntimeContractDiscovery {
  const repositoryRegistry = createRepositoryRegistryFromPreferences(basePath, preferences);
  const projectRoot = realpathSync.native(repositoryRegistry.projectRoot);
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

  const directory = openValidatedContractDirectory(projectRoot, candidateDir);
  if (!directory) return { status: "invalid" };

  try {
    const entryNames = configured?.entry ? [configured.entry] : DEFAULT_ENTRY_NAMES;
    const members = captureContractMembers(
      directory.path,
      ["AGENT.md", "README.md", ...entryNames],
      hooks?.afterMemberCapture,
    );
    assertContractDirectoryIdentity(directory);
    assertContractMembersIdentity(members);

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
    for (const name of entryNames) {
      entry = readFromContractDirectory(
        name,
        () => resolveContractEntry(
          projectRoot,
          directory.path,
          members.get(name)!,
          () => hooks?.beforeFileOpen?.(name),
        ),
      );
      if (entry) break;
    }

    assertContractMembersIdentity(members);
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
  const truncation = document.truncated ? " truncated" : "";
  return [
    `<runtime-contract-snapshot kind=${JSON.stringify(label)} path=${JSON.stringify(document.path)}${truncation}>`,
    JSON.stringify(document.content),
    "</runtime-contract-snapshot>",
  ];
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
      `- Canonical entry point observed during context assembly: ${JSON.stringify(contract.entry.path)} (${contract.entry.size} bytes).`,
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
