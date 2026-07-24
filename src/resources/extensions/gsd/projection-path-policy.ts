const reservedNames = new Set([
  ".compat.json",
  "active.json",
  "auto.lock",
  "gsd.db",
  "orchestrator.json",
  "slice-orchestrator.json",
  "unit-claims.db",
]);

const reservedDirectories = new Set([
  "backups",
  "migration",
  "migration-applications",
  "recovery-applications",
  "runtime",
  "workflow",
  "workflows",
]);

const managedDirectories = new Set([
  "artifact",
  "artifacts",
  "backlog",
  "capture",
  "captures",
  "milestone",
  "milestones",
  "milestones.migrating",
  "notes",
  "phases",
  "plans",
  "reports",
  "research",
  "roadmaps",
  "slices",
  "summaries",
  "tasks",
  "validation",
  "verification",
]);

const managedRootFiles = new Set([
  "backlog.md",
  "decisions.md",
  "knowledge.md",
  "last-snapshot.md",
  "metrics.json",
  "project.md",
  "queue.md",
  "requirements.md",
  "roadmap.md",
  "state.md",
]);

export function classifyGsdLogicalPath(
  logicalPath: string,
): "control" | "invalid" | "managed" | "unmanaged" {
  const parts = logicalPath.replaceAll("\\", "/").split("/");
  if (parts.length === 0 || parts.some(part => part.length === 0 || part === "." || part === "..")) {
    return "invalid";
  }
  const normalized = parts.map(part => (
    part.normalize("NFC").replace(/[. ]+$/u, "").toLocaleLowerCase("en-US")
  ));
  if (normalized.some(part => part.length === 0 || part.includes(":"))) return "invalid";
  const first = normalized[0];
  if (reservedDirectories.has(first)
    || reservedNames.has(first)
    || first.startsWith("gsd.db-")) {
    return "control";
  }
  return managedDirectories.has(first)
    || managedRootFiles.has(first)
    ? "managed"
    : "unmanaged";
}
