export type GsdExitCode = 0 | 1 | 10 | 11;
const VALID_EXIT_CODES = new Set<number>([0, 1, 10, 11]);

export interface GsdResult {
  exitCode: GsdExitCode;
  stdout: string;
  stderr: string;
  json: unknown | null;
}

export type Spawner = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; signal?: AbortSignal; stdin?: string; },
) => Promise<{ exitCode: number; stdout: string; stderr: string; }>;

export interface GsdRunnerOptions {
  binary?: string;
  cwd: string;
  spawn: Spawner;
  /**
   * When set, long-running subcommands (new-milestone, auto) pass
   * `--timeout <n>` (0 = disabled). Belt-and-braces only — auto/new-milestone
   * are multi-turn upstream and already exempt from the idle timeout; a 16+
   * minute --print build completed cleanly without this. Regression insurance,
   * not a fix for anything currently observed.
   */
  timeoutSeconds?: number;
}

function parseStdoutJson(stdout: string): unknown | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  // GSD emits a single JSON object/array followed by newline for query;
  // for streaming subcommands it emits JSONL events. We try whole-document
  // parse first, then fall back to last-line parse.
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).filter((l) => l.length > 0);
    for (let i = lines.length - 1; i >= 0; i--) {
      try { return JSON.parse(lines[i]); } catch { /* keep scanning */ }
    }
    return null;
  }
}

/**
 * Parse every newline-delimited JSON line in stdout, skipping non-JSON lines.
 * Returns parsed values in order. Use for streaming subcommands (JSONL events).
 */
export function parseJsonLines(stdout: string): unknown[] {
  const results: unknown[] = [];
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      results.push(JSON.parse(trimmed));
    } catch {
      // skip non-JSON lines
    }
  }
  return results;
}

export class GsdRunner {
  private binary: string;
  private cwd: string;
  private spawn: Spawner;
  private timeoutSeconds: number | undefined;

  constructor(opts: GsdRunnerOptions) {
    this.binary = opts.binary ?? "gsd";
    this.cwd = opts.cwd;
    this.spawn = opts.spawn;
    this.timeoutSeconds = opts.timeoutSeconds;
  }

  async query(signal?: AbortSignal): Promise<GsdResult> {
    return this.run(["headless", "--output-format", "json", "query"], { signal });
  }

  /** headless arg prefix for long-running subcommands (query stays untouched). */
  private longRunArgs(): string[] {
    const args = ["headless", "--output-format", "json"];
    if (this.timeoutSeconds !== undefined) args.push("--timeout", String(this.timeoutSeconds));
    return args;
  }

  async newMilestone(specPath: string, opts: { auto?: boolean; signal?: AbortSignal } = {}): Promise<GsdResult> {
    const args = [...this.longRunArgs(), "new-milestone", "--context", specPath];
    if (opts.auto) args.push("--auto");
    return this.run(args, { signal: opts.signal });
  }

  async auto(opts: { signal?: AbortSignal } = {}): Promise<GsdResult> {
    return this.run([...this.longRunArgs(), "auto"], { signal: opts.signal });
  }

  /**
   * Extract all JSONL events from a GsdResult's stdout.
   * Use for streaming subcommands that emit line-by-line JSON.
   */
  extractEvents(result: GsdResult): unknown[] {
    return parseJsonLines(result.stdout);
  }

  private async run(args: string[], opts: { signal?: AbortSignal }): Promise<GsdResult> {
    const { exitCode, stdout, stderr } = await this.spawn(this.binary, args, { cwd: this.cwd, signal: opts.signal });
    if (!VALID_EXIT_CODES.has(exitCode)) {
      throw new Error(`gsd headless ${args[args.length - 1]} unexpected exit code ${exitCode}; stderr=${stderr}`);
    }
    return { exitCode: exitCode as GsdExitCode, stdout, stderr, json: parseStdoutJson(stdout) };
  }
}

// NOTE: realSpawner has been moved to ./real-spawner.ts to isolate the
// child_process dependency. Import from there instead.
export { realSpawner } from "./real-spawner.js";
