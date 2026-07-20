import { stat } from "node:fs/promises";
import { join } from "node:path";

/** Max mtime (epoch ms) across the .gsd liveness path set, or null when
 *  nothing is observable. F6.0-5: JSON-mode gsd children buffer ALL stdout
 *  until exit (e2e grok-m4 F-G7 — zero incremental bytes on healthy runs),
 *  so stdout silence is not evidence of a hang; on-disk churn is the only
 *  liveness signal available without upstream changes.
 *
 *  This is the bridge's ONE narrow carve-out from the "never consume .gsd/
 *  internals" rule: metadata only (fs.stat), never content, best-effort —
 *  every failure degrades to "no signal" and can never abort a build. */
export type ActivityStamp = () => Promise<number | null>;

/** Files gsd touches continuously during a healthy run, plus directories
 *  whose mtimes bump when entries are added. Tolerant: missing paths skip. */
const LIVENESS_PATHS = [
  join(".gsd", "gsd.db-wal"),
  join(".gsd", "gsd.db-shm"),
  join(".gsd", "gsd.db"),
  join(".gsd", "notifications.jsonl"),
  join(".gsd", "activity"),
  join(".gsd", "journal"),
  join(".gsd", "exec"),
];

type StatFn = (path: string) => Promise<{ mtimeMs: number }>;

export function makeActivityStamp(cwd: string, statFn: StatFn = stat): ActivityStamp {
  return async () => {
    let max: number | null = null;
    for (const rel of LIVENESS_PATHS) {
      try {
        const s = await statFn(join(cwd, rel));
        if (max === null || s.mtimeMs > max) max = s.mtimeMs;
      } catch {
        // missing path or stat error — no signal from this path
      }
    }
    return max;
  };
}
