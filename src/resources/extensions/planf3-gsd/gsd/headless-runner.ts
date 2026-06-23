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

export class GsdRunner {
  private binary: string;
  private cwd: string;
  private spawn: Spawner;

  constructor(opts: GsdRunnerOptions) {
    this.binary = opts.binary ?? "gsd";
    this.cwd = opts.cwd;
    this.spawn = opts.spawn;
  }

  async query(signal?: AbortSignal): Promise<GsdResult> {
    return this.run(["headless", "--output-format", "json", "query"], { signal });
  }

  async newMilestone(specPath: string, opts: { auto?: boolean; signal?: AbortSignal } = {}): Promise<GsdResult> {
    const args = ["headless", "--output-format", "json", "new-milestone", "--context", specPath];
    if (opts.auto) args.push("--auto");
    return this.run(args, { signal: opts.signal });
  }

  private async run(args: string[], opts: { signal?: AbortSignal }): Promise<GsdResult> {
    const { exitCode, stdout, stderr } = await this.spawn(this.binary, args, { cwd: this.cwd, signal: opts.signal });
    if (!VALID_EXIT_CODES.has(exitCode)) {
      throw new Error(`gsd headless ${args[args.length - 1]} unexpected exit code ${exitCode}; stderr=${stderr}`);
    }
    return { exitCode: exitCode as GsdExitCode, stdout, stderr, json: parseStdoutJson(stdout) };
  }
}
