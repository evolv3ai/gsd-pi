// Project/App: gsd-pi
// File Purpose: Lightweight worktree post-create hook runner.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { parse as parseYaml } from "yaml";

import { gsdHome } from "./gsd-home.js";
import { gsdRoot } from "./paths.js";

function readPreferencesObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;

  const content = readFileSync(path, "utf-8");
  try {
    const startMarker = content.startsWith("---\r\n") ? "---\r\n" : "---\n";
    if (content.startsWith(startMarker)) {
      const searchStart = startMarker.length;
      const endIdx = content.indexOf("\n---", searchStart);
      if (endIdx === -1) return null;

      const parsed = parseYaml(content.slice(searchStart, endIdx).replace(/\r/g, ""));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    }

    const gitLines: string[] = [];
    let inGitSection = false;
    for (const rawLine of content.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      const heading = line.match(/^##\s+(.+)$/);
      if (heading) {
        inGitSection = heading[1].trim().toLowerCase().replace(/\s+/g, "_") === "git";
        continue;
      }
      if (inGitSection && line.trim() && !line.trimStart().startsWith("#")) {
        gitLines.push(line.replace(/^\s*-\s*/, ""));
      }
    }
    if (gitLines.length === 0) return null;

    const parsed = parseYaml(gitLines.join("\n"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { git: parsed as Record<string, unknown> }
      : null;
  } catch {
    return null;
  }
}

function extractHookPath(preferences: Record<string, unknown> | null): string | null {
  const git = preferences?.git;
  if (!git || typeof git !== "object" || Array.isArray(git)) return null;
  const hookPath = (git as Record<string, unknown>).worktree_post_create;
  return typeof hookPath === "string" && hookPath.trim() ? hookPath : null;
}

function resolveConfiguredHookPath(sourceDir: string): string | null {
  const paths = [
    join(homedir(), ".pi", "agent", "gsd-preferences.md"),
    join(gsdHome(), "preferences.md"),
    join(gsdHome(), "PREFERENCES.md"),
    join(gsdRoot(sourceDir), "preferences.md"),
    join(gsdRoot(sourceDir), "PREFERENCES.md"),
  ];

  let hookPath: string | null = null;
  for (const path of paths) {
    hookPath = extractHookPath(readPreferencesObject(path)) ?? hookPath;
  }
  return hookPath;
}

/**
 * Run the user-configured post-create hook script after worktree creation.
 * The script receives SOURCE_DIR and WORKTREE_DIR as environment variables.
 * Failure is non-fatal -- returns the error message or null on success.
 *
 * Reads git.worktree_post_create from effective global/project preferences
 * unless hookPath is provided directly.
 */
export function runWorktreePostCreateHook(
  sourceDir: string,
  worktreeDir: string,
  hookPath?: string,
): string | null {
  if (hookPath === undefined) {
    hookPath = resolveConfiguredHookPath(sourceDir) ?? undefined;
  }
  if (!hookPath) return null;

  let resolved = isAbsolute(hookPath) ? hookPath : join(sourceDir, hookPath);
  if (!existsSync(resolved)) {
    return `Worktree post-create hook not found: ${resolved}`;
  }
  if (process.platform === "win32") {
    try {
      resolved = realpathSync.native(resolved);
    } catch {
      // Keep the original path; the exec error below will include the failure.
    }
  }

  try {
    const needsShell = process.platform === "win32" && /\.(bat|cmd)$/i.test(resolved);
    execFileSync(resolved, [], {
      cwd: worktreeDir,
      env: {
        ...process.env,
        SOURCE_DIR: sourceDir,
        WORKTREE_DIR: worktreeDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      timeout: 30_000,
      shell: needsShell,
    });
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Worktree post-create hook failed: ${msg}`;
  }
}
