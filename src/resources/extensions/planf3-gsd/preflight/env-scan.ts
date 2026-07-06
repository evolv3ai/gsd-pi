import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EnvVarFinding } from "./types.js";

/** Vite's env file set, in ascending precedence order we report first-match on. */
export function envFileSet(mode?: string): string[] {
  return [".env", ".env.local", ...(mode ? [`.env.${mode}`] : [])];
}

const ENV_LINE_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/;

async function namesInFile(path: string): Promise<Set<string>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return new Set();
  }
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const m = ENV_LINE_RE.exec(line.trim());
    if (m) names.add(m[1]); // key only — the value is discarded unread past `=`
  }
  return names;
}

/**
 * Presence + provenance only, never values (spec §9). env-file ranks above
 * process.env because shell-exported vars do NOT reach the vite SSR worker —
 * proven live in the Editorial HN run (USE_FIXTURES silently ignored from shell).
 */
export async function scanEnvVars(
  names: string[],
  deps: { root: string; mode?: string; env?: NodeJS.ProcessEnv },
): Promise<EnvVarFinding[]> {
  const env = deps.env ?? process.env;
  const files = envFileSet(deps.mode);
  const perFile = await Promise.all(files.map(async (f) => ({ file: f, names: await namesInFile(join(deps.root, f)) })));
  return names.map((name) => {
    const hit = perFile.find((p) => p.names.has(name));
    if (hit) return { name, provenance: "env-file" as const, file: hit.file };
    if (env[name] !== undefined) return { name, provenance: "process-env" as const, file: null };
    return { name, provenance: "not-found" as const, file: null };
  });
}

const GUESS_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:KEY|URL|TOKEN|SECRET|ID)\b/g;

/** Heuristic fallback for plans without #integrations — rows render as `guessed`. */
export function guessEnvNames(planText: string): string[] {
  return [...new Set(planText.match(GUESS_RE) ?? [])];
}
