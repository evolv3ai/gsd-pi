/**
 * Canonical project path key for ProjectStoreManager Map lookups.
 * Browser-safe (no fs.realpath): normalizes separators, trailing slashes, and `.` / `..` segments.
 */
export function normalizeProjectPath(projectCwd: string): string {
  const trimmed = projectCwd.trim()
  if (!trimmed) return trimmed

  const isAbsolute = trimmed.startsWith("/")
  const segments = trimmed.replace(/\\/g, "/").split("/")

  const resolved: string[] = []
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      if (resolved.length > 0) resolved.pop()
      continue
    }
    resolved.push(segment)
  }

  if (isAbsolute) {
    return resolved.length === 0 ? "/" : `/${resolved.join("/")}`
  }
  return resolved.join("/")
}
