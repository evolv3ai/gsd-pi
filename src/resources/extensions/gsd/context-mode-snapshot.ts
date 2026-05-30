// GSD context-mode compaction snapshot — durable re-entry digest written before
// session compaction or step-boundary session reset.

import { deriveState } from "./state.js";
import { writeCompactionSnapshot } from "./compaction-snapshot.js";
import { logWarning as safetyLogWarning } from "./workflow-logger.js";

export async function writeContextModeCompactionSnapshot(basePath: string): Promise<void> {
  try {
    const { loadEffectiveGSDPreferences } = await import("./preferences.js");
    const { isContextModeEnabled } = await import("./preferences-types.js");
    const prefs = loadEffectiveGSDPreferences(basePath);
    if (!isContextModeEnabled(prefs?.preferences)) return;

    const { ensureDbOpen } = await import("./bootstrap/dynamic-tools.js");
    await ensureDbOpen(basePath);

    let activeContext: string | null = null;
    try {
      const state = await deriveState(basePath);
      if (state.activeMilestone && state.activeSlice && state.activeTask) {
        activeContext =
          `Active: ${state.activeMilestone.id} / ${state.activeSlice.id} / ${state.activeTask.id}` +
          (state.activeTask.title ? ` - ${state.activeTask.title}` : "");
      }
    } catch {
      /* non-fatal */
    }

    writeCompactionSnapshot(basePath, { activeContext });
  } catch (err) {
    safetyLogWarning(
      "context-mode",
      `failed to write compaction snapshot: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
