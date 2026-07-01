// Project/App: gsd-pi
// File Purpose: Detect interrupted slice work from CONTINUE artifacts (legacy path).

import { join } from 'node:path';
import { loadFile } from '../../files.js';
import { resolveSliceFile, resolveSlicePath } from '../../paths.js';

export async function detectInterruptedWork(
  basePath: string,
  milestoneId: string,
  sliceId: string,
): Promise<boolean> {
  const sliceDir = resolveSlicePath(basePath, milestoneId, sliceId);
  const continueFile = sliceDir
    ? resolveSliceFile(basePath, milestoneId, sliceId, "CONTINUE")
    : null;
  if (continueFile && await loadFile(continueFile)) return true;
  if (sliceDir && await loadFile(join(sliceDir, "continue.md"))) return true;
  return false;
}

export function interruptedWorkNextAction(
  taskId: string,
  taskTitle: string,
  sliceId: string,
  interrupted: boolean,
): string {
  return interrupted
    ? `Resume interrupted work on ${taskId}: ${taskTitle} in slice ${sliceId}. Read continue.md first.`
    : `Execute ${taskId}: ${taskTitle} in slice ${sliceId}.`;
}
