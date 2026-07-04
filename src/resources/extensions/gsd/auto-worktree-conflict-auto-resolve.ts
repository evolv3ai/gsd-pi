// gsd-pi — Conflict auto-resolve policy for auto-worktree merges.
//
// Owns the pure path policy for conflict paths that are safe to resolve
// mechanically. Git mutation stays in git-conflict-resolve.ts.

/** Patterns for machine-generated build artifacts that can be safely
 * auto-resolved by accepting --theirs during merge. These files are
 * regenerable and never contain meaningful manual edits. */
export const SAFE_AUTO_RESOLVE_PATTERNS: RegExp[] = [
  /\.tsbuildinfo$/,
  /\.pyc$/,
  /\/__pycache__\//,
  /\.DS_Store$/,
  /\.map$/,
  // Regenerable dependency lockfiles. These are fully derivable from their
  // manifests by the package manager, so accepting the merge side during
  // auto-resolve clears the conflict markers without losing meaningful edits —
  // and stops auto-mode from hard-pausing on a lockfile conflict (issue #828).
  /(?:^|\/)pnpm-lock\.yaml$/,
  /(?:^|\/)package-lock\.json$/,
  /(?:^|\/)npm-shrinkwrap\.json$/,
  /(?:^|\/)yarn\.lock$/,
  /(?:^|\/)bun\.lockb?$/,
  /(?:^|\/)Cargo\.lock$/,
  /(?:^|\/)composer\.lock$/,
  /(?:^|\/)Gemfile\.lock$/,
  /(?:^|\/)Pipfile\.lock$/,
  /(?:^|\/)poetry\.lock$/,
];

/** Returns true if the file path is safe to auto-resolve during merge.
 * Covers `.gsd/` state files, common build artifacts, and regenerable
 * dependency lockfiles. */
export function isSafeToAutoResolve(filePath: string): boolean {
  return filePath.startsWith(".gsd/")
    || SAFE_AUTO_RESOLVE_PATTERNS.some((re) => re.test(filePath));
}
