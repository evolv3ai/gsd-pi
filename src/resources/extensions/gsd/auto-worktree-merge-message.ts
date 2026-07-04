// gsd-pi — Milestone merge commit-message construction.
//
// Owns the completed-slice/task summary and milestone title fallback policy used
// by auto-worktree milestone merge commits and publication summaries.

import {
  getMilestone,
  getMilestoneSlices,
  getSliceTasks,
  isDbAvailable,
} from "./gsd-db.js";

interface CompletedTaskSummary {
  id: string;
  title: string;
}

interface CompletedSliceSummary {
  id: string;
  title: string;
  tasks: CompletedTaskSummary[];
}

export interface MilestoneMergeMessageRequest {
  milestoneId: string;
  milestoneBranch: string;
  roadmapContent: string;
}

export interface MilestoneMergeMessage {
  commitMessage: string;
  milestoneTitle: string;
  sliceSummaries: string[];
}

interface MilestoneMergeMessageDeps {
  isDbAvailable: typeof isDbAvailable;
  getMilestone: typeof getMilestone;
  getMilestoneSlices: typeof getMilestoneSlices;
  getSliceTasks: typeof getSliceTasks;
}

const defaultDeps: MilestoneMergeMessageDeps = {
  isDbAvailable,
  getMilestone,
  getMilestoneSlices,
  getSliceTasks,
};

let deps: MilestoneMergeMessageDeps = defaultDeps;

export function _setMilestoneMergeMessageDepsForTests(
  overrides: Partial<MilestoneMergeMessageDeps>,
): void {
  deps = { ...defaultDeps, ...overrides };
}

export function _resetMilestoneMergeMessageDepsForTests(): void {
  deps = defaultDeps;
}

function stripGsdDisplayPrefix(value: string | undefined | null, id: string): string | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;

  const lower = raw.toLowerCase();
  const idLower = id.toLowerCase();
  if (lower.startsWith(`${idLower}:`)) {
    return raw.slice(id.length + 1).trim() || undefined;
  }
  return raw;
}

function getDbCompletedSlices(milestoneId: string): CompletedSliceSummary[] {
  if (!deps.isDbAvailable()) return [];
  return deps.getMilestoneSlices(milestoneId)
    .filter((slice) => slice.status === "complete")
    .map((slice) => ({
      id: slice.id,
      title: stripGsdDisplayPrefix(slice.title, slice.id) ?? slice.id,
      tasks: deps.getSliceTasks(milestoneId, slice.id)
        .filter((task) => task.status === "complete")
        .map((task) => ({
          id: task.id,
          title: stripGsdDisplayPrefix(task.title, task.id) ?? task.id,
        })),
    }));
}

function getRoadmapCompletedSlices(roadmapContent: string): CompletedSliceSummary[] {
  if (!roadmapContent) return [];

  const completedSlices: CompletedSliceSummary[] = [];
  const sliceRe = /- \[x\] \*\*(\w+):\s*(.+?)\*\*/gi;
  let match: RegExpExecArray | null;
  while ((match = sliceRe.exec(roadmapContent)) !== null) {
    completedSlices.push({ id: match[1], title: match[2], tasks: [] });
  }
  return completedSlices;
}

function getCompletedSlices(
  milestoneId: string,
  roadmapContent: string,
): CompletedSliceSummary[] {
  const dbCompletedSlices = getDbCompletedSlices(milestoneId);
  if (dbCompletedSlices.length > 0) return dbCompletedSlices;
  return getRoadmapCompletedSlices(roadmapContent);
}

function getRoadmapMilestoneTitle(milestoneId: string, roadmapContent: string): string | undefined {
  if (!roadmapContent) return undefined;
  const titleMatch = roadmapContent.match(new RegExp(`^#\\s+${milestoneId}:\\s*(.+)`, "m"));
  return titleMatch?.[1]?.trim() || undefined;
}

function getMilestoneTitle(milestoneId: string, roadmapContent: string): string {
  const dbMilestone = deps.getMilestone(milestoneId);
  const dbTitle = stripGsdDisplayPrefix(dbMilestone?.title, milestoneId);
  return dbTitle ?? getRoadmapMilestoneTitle(milestoneId, roadmapContent) ?? milestoneId;
}

function buildCommitMessage(request: {
  completedSlices: CompletedSliceSummary[];
  milestoneBranch: string;
  milestoneId: string;
  milestoneTitle: string;
}): string {
  const { completedSlices, milestoneBranch, milestoneId, milestoneTitle } = request;
  const subject = `feat: ${milestoneTitle}`;
  const milestoneContext = milestoneTitle === milestoneId
    ? `Milestone: ${milestoneId}`
    : `Milestone: ${milestoneId} - ${milestoneTitle}`;

  if (completedSlices.length === 0) {
    return `${subject}\n\n${milestoneContext}\nGSD-Milestone: ${milestoneId}\nBranch: ${milestoneBranch}`;
  }

  const sliceLines = completedSlices
    .map((slice) => `- ${slice.id}: ${slice.title}`)
    .join("\n");
  const taskLines = completedSlices
    .flatMap((slice) => slice.tasks.map((task) => `- ${slice.id}/${task.id}: ${task.title}`))
    .join("\n");
  const taskBlock = taskLines ? `\n\nCompleted tasks:\n${taskLines}` : "";

  return `${subject}\n\nCompleted slices:\n${sliceLines}${taskBlock}\n\n${milestoneContext}\nGSD-Milestone: ${milestoneId}\nBranch: ${milestoneBranch}`;
}

export function buildMilestoneMergeMessage(
  request: MilestoneMergeMessageRequest,
): MilestoneMergeMessage {
  const { milestoneId, milestoneBranch, roadmapContent } = request;
  const completedSlices = getCompletedSlices(milestoneId, roadmapContent);
  const milestoneTitle = getMilestoneTitle(milestoneId, roadmapContent);
  return {
    commitMessage: buildCommitMessage({
      completedSlices,
      milestoneBranch,
      milestoneId,
      milestoneTitle,
    }),
    milestoneTitle,
    sliceSummaries: completedSlices.map((slice) => `### ${slice.id}\n${slice.title}`),
  };
}
