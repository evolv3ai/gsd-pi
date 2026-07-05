export interface WorktreeCliWorktree {
  name: string
  path: string
  branch: string
}

export type WorktreeFlagPlan =
  | { action: 'resume'; worktree: WorktreeCliWorktree }
  | { action: 'show-multiple'; worktrees: WorktreeCliWorktree[] }
  | { action: 'create'; name: string }

export function planWorktreeFlag(
  worktreeFlag: boolean | string,
  existing: WorktreeCliWorktree[],
  withChanges: WorktreeCliWorktree[],
  generateName: () => string,
): WorktreeFlagPlan {
  if (worktreeFlag === true) {
    if (withChanges.length === 1) {
      return { action: 'resume', worktree: withChanges[0] }
    }

    if (withChanges.length > 1) {
      return { action: 'show-multiple', worktrees: withChanges }
    }

    return { action: 'create', name: generateName() }
  }

  if (typeof worktreeFlag !== 'string') {
    return { action: 'create', name: generateName() }
  }

  const found = existing.find((wt) => wt.name === worktreeFlag)
  if (found) {
    return { action: 'resume', worktree: found }
  }

  return { action: 'create', name: worktreeFlag }
}
