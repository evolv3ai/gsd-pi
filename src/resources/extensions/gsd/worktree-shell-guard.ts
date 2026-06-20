// Project/App: gsd-pi
// File Purpose: Detect shell commands that reference the project root from a milestone worktree.

import { realpathSync } from "node:fs";
import path from "node:path";

import { projectRootFromWorktreePath } from "./worktree-root.js";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeScanPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.startsWith("/private/var/")
    ? normalized.slice("/private".length)
    : normalized;
}

function parseWorktreeBase(baseDir: string): { originalRoot: string; worktreeRoot: string } | null {
  const normalizedBase = normalizeScanPath(baseDir);
  const originalRoot = projectRootFromWorktreePath(normalizedBase);
  if (!originalRoot) return null;
  return { originalRoot, worktreeRoot: normalizedBase };
}

function pathInside(parent: string, target: string): boolean {
  const parentWithSep = parent.endsWith("/") ? parent : `${parent}/`;
  return target === parent || target.startsWith(parentWithSep);
}

function comparablePathVariants(value: string): string[] {
  const variants = new Set<string>();
  const normalized = normalizeScanPath(path.resolve(value));
  variants.add(normalized);
  try {
    variants.add(normalizeScanPath(realpathSync(normalized)));
  } catch {
    // Nonexistent paths are still compared lexically.
  }
  if (normalized.startsWith("/private/var/")) {
    variants.add(normalized.replace(/^\/private\/var\//, "/var/"));
  } else if (normalized.startsWith("/var/")) {
    variants.add(`/private${normalized}`);
  }
  return [...variants];
}

function pathInsideAny(parents: readonly string[], targets: readonly string[]): boolean {
  return targets.some((target) => parents.some((parent) => pathInside(parent, target)));
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === "'" || first === '"' || first === "`") && last === first) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function extractPathLikeValues(script: string): string[] {
  const values: string[] = [];
  const push = (candidate: string) => {
    const cleaned = stripWrappingQuotes(candidate).trim();
    if (!cleaned) return;
    values.push(cleaned);
  };
  const pushQuotedLiterals = (source: string, depth = 0) => {
    for (const match of source.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)) {
      push(match[2]);
      if (depth < 2 && /["'`]/.test(match[2])) {
        pushQuotedLiterals(match[2], depth + 1);
      }
    }
  };

  for (const match of script.matchAll(/(?:^|[;\n\r]|\&\&|\|\|)\s*cd\s+([^\n\r;|&]+)/g)) {
    push(match[1]);
  }
  for (const match of script.matchAll(/process\.chdir\(\s*([^\n\r;]+?)\s*\)/g)) {
    push(match[1]);
    pushQuotedLiterals(match[1]);
  }
  pushQuotedLiterals(script);
  return values;
}

export function resolvesToOriginalRootOutsideWorktree(script: string, baseDir: string): boolean {
  const parsed = parseWorktreeBase(baseDir);
  if (!parsed) return false;

  const normalizedWorktree = normalizeScanPath(path.resolve(parsed.worktreeRoot));
  const normalizedOriginalRoot = normalizeScanPath(path.resolve(parsed.originalRoot));
  const worktreeRoots = comparablePathVariants(normalizedWorktree);
  const originalRoots = comparablePathVariants(normalizedOriginalRoot);
  for (const value of extractPathLikeValues(script)) {
    const resolved = comparablePathVariants(path.resolve(normalizedWorktree, value));
    if (pathInsideAny(originalRoots, resolved) && !pathInsideAny(worktreeRoots, resolved)) {
      return true;
    }
  }
  return false;
}

export function scriptReferencesOriginalRootFromWorktree(script: string, baseDir: string): boolean {
  const parsed = parseWorktreeBase(baseDir);
  if (!parsed) return false;
  const normalizedScript = script.replace(/\\/g, "/");
  return comparablePathVariants(parsed.originalRoot).some((originalRoot) => {
    const originalRootPattern = new RegExp(
      `${escapeRegExp(originalRoot)}(?=$|[\\s'"\\\`;)&|<>]|/(?!\\.gsd(?:-worktrees|/worktrees)(?:/|$)))`,
    );
    return originalRootPattern.test(normalizedScript);
  });
}

export function bashReferencesProjectRootOutsideWorktree(script: string, baseDir: string): boolean {
  return resolvesToOriginalRootOutsideWorktree(script, baseDir)
    || scriptReferencesOriginalRootFromWorktree(script, baseDir);
}
