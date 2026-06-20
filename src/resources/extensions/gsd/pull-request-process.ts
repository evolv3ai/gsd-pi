// Project/App: gsd-pi
// File Purpose: Process-level pull request policy for GSD-generated PRs.

import { createDraftPR } from "./git-service.js";
import {
  buildPrEvidence,
  type PrEvidence,
  type PrEvidenceInput,
} from "./pr-evidence.js";

export interface DraftPullRequestOptions {
  head: string;
  base: string;
}

export interface DraftPullRequestDeps {
  createDraftPR: (
    basePath: string,
    milestoneId: string,
    title: string,
    body: string,
    opts: DraftPullRequestOptions,
  ) => string | null;
}

export function buildPullRequestEvidence(input: PrEvidenceInput): PrEvidence {
  return buildPrEvidence({
    ...input,
    aiAssisted: false,
  });
}

export function createDraftPullRequestFromEvidence(
  basePath: string,
  milestoneId: string,
  evidence: PrEvidence,
  options: DraftPullRequestOptions,
  deps: DraftPullRequestDeps = { createDraftPR },
): string | null {
  return deps.createDraftPR(basePath, milestoneId, evidence.title, evidence.body, options);
}
