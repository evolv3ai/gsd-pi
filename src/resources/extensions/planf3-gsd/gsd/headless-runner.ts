export type GsdExitCode = 0 | 1 | 10 | 11;
const VALID_EXIT_CODES = new Set<number>([0, 1, 10, 11]);

export interface GsdResult {
  exitCode: GsdExitCode;
  stdout: string;
  stderr: string;
  json: unknown | null;
}

export interface SpawnOptions {
  cwd?: string;
  signal?: AbortSignal;
  /** Piped to the child's stdin — except the literal sentinel "ignore", which
   *  closes stdin instead (real-spawner discriminates on it) so interactive
   *  CLIs fail fast rather than hanging on input. */
  stdin?: "ignore" | (string & {});
  /** Hard wall-clock timeout in ms, passed through to child_process.spawn. */
  timeoutMs?: number;
  /** Explicit environment for the child process; defaults to inheriting the parent's. */
  env?: NodeJS.ProcessEnv;
  /** Fired once per stdout data chunk, BEFORE the chunk is appended to the
   *  buffered stdout string. Used by the bridge's inactivity guard (F4 / #1294)
   *  to reset the idle timer on real progress and fast-path on the smart-entry
   *  menu-notification signature. Absent onStdout: buffered behavior only. */
  onStdout?: (chunk: string) => void;
}

export type Spawner = (
  cmd: string,
  args: string[],
  opts: SpawnOptions,
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

  async newMilestone(specPath: string, opts: { auto?: boolean; signal?: AbortSignal; onStdout?: (chunk: string) => void } = {}): Promise<GsdResult> {
    const args = [...this.longRunArgs(), "new-milestone", "--context", specPath];
    if (opts.auto) args.push("--auto");
    return this.run(args, { signal: opts.signal, onStdout: opts.onStdout });
  }

  async auto(opts: { signal?: AbortSignal; onStdout?: (chunk: string) => void } = {}): Promise<GsdResult> {
    return this.run([...this.longRunArgs(), "auto"], { signal: opts.signal, onStdout: opts.onStdout });
  }

  /** Short control passthroughs (M4): steer/pause/stop return promptly — no
   *  long-run prefix, no idle machinery. The instruction is ONE argv token. */
  async steer(instruction: string): Promise<GsdResult> {
    return this.run(["headless", "--output-format", "json", "steer", instruction], {});
  }

  async pause(): Promise<GsdResult> {
    return this.run(["headless", "--output-format", "json", "pause"], {});
  }

  async stop(): Promise<GsdResult> {
    return this.run(["headless", "--output-format", "json", "stop"], {});
  }

  /** Step-mode resume (M4): one bounded `next` round — long-running like auto. */
  async next(opts: { signal?: AbortSignal; onStdout?: (chunk: string) => void } = {}): Promise<GsdResult> {
    return this.run([...this.longRunArgs(), "next"], opts);
  }

  /**
   * Extract all JSONL events from a GsdResult's stdout.
   * Use for streaming subcommands that emit line-by-line JSON.
   */
  extractEvents(result: GsdResult): unknown[] {
    return parseJsonLines(result.stdout);
  }

  private async run(args: string[], opts: { signal?: AbortSignal; onStdout?: (chunk: string) => void }): Promise<GsdResult> {
    const spawnOpts: SpawnOptions = { cwd: this.cwd };
    if (opts.signal !== undefined) spawnOpts.signal = opts.signal;
    if (opts.onStdout !== undefined) spawnOpts.onStdout = opts.onStdout;
    const { exitCode, stdout, stderr } = await this.spawn(this.binary, args, spawnOpts);
    if (!VALID_EXIT_CODES.has(exitCode)) {
      throw new Error(`gsd headless ${args[args.length - 1]} unexpected exit code ${exitCode}; stderr=${stderr}`);
    }
    return { exitCode: exitCode as GsdExitCode, stdout, stderr, json: parseStdoutJson(stdout) };
  }
}

// NOTE: realSpawner has been moved to ./real-spawner.ts to isolate the
// child_process dependency. Import from there instead.
export { realSpawner } from "./real-spawner.js";
