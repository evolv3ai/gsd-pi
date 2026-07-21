// Project/App: gsd-pi
// File Purpose: Pure legacy worktree topology contributions from retained source evidence.

import { isUtf8 } from "node:buffer";

import {
  addLegacyImportCandidate,
  addLegacyImportDiagnosis,
  type LegacyImportDecodedSourceFile,
  type LegacyImportPendingCandidate,
  type LegacyImportPendingDiagnosis,
} from "./legacy-import-preview-interpretation.js";
import type { LegacyImportSourceCapture } from "./legacy-import-preview-source.js";

interface WorktreeGroup {
  files: LegacyImportDecodedSourceFile[];
}

interface MarkerEvidence {
  file: LegacyImportDecodedSourceFile;
  id: string;
  identity: string;
}

const EVIDENCE_KIND = "portable-git-marker-descriptor";

function topologyPath(file: LegacyImportDecodedSourceFile, capture: LegacyImportSourceCapture): string {
  const root = capture.roots.find((candidate) => candidate.id === file.entry.root_id);
  if (root === undefined) return file.entry.logical_path;
  if (/^(?:\.gsd(?:-worktrees|\.migrating)?|\$GSD_STATE_DIR)(?:\/|$)/u.test(root.logical_path)) {
    return file.entry.logical_path;
  }
  if (file.entry.logical_path === root.logical_path) return "";
  return file.entry.logical_path.slice(root.logical_path.length + 1);
}

function topologyGroupKey(
  file: LegacyImportDecodedSourceFile,
  capture: LegacyImportSourceCapture,
): string {
  const root = capture.roots.find((candidate) => candidate.id === file.entry.root_id);
  if (root !== undefined && /^(?:\.gsd(?:-worktrees|\.migrating)?|\$GSD_STATE_DIR)(?:\/|$)/u.test(root.logical_path)) {
    return "project-topology";
  }
  return file.entry.root_id;
}

function isWorktreeSurface(
  file: LegacyImportDecodedSourceFile,
  capture: LegacyImportSourceCapture,
): boolean {
  const path = topologyPath(file, capture);
  return file.entry.kind === "symlink"
    ? /(?:^|\/)(?:(?:project\/)?\.gsd|\.gsd-worktrees\/M\d+|\.gsd\/worktrees\/M\d+)$/u.test(path)
    : /(?:^|\/)(?:\.gsd(?:\.migrating)?\/PREFERENCES\.md|\.gsd-worktrees\/M\d+\/(?:git-marker\.txt|README\.txt)|\.gsd\/worktrees\/M\d+\/git-marker\.txt|(?:(?:state|\$GSD_STATE_DIR)\/projects\/[^/]+\/worktrees|shared)\/M\d+\/git-marker\.txt)$/u.test(path);
}

function prepareFile(file: LegacyImportDecodedSourceFile): void {
  file.parserId = "gsd-worktree-topology";
  if (file.entry.kind === "symlink") {
    file.kind = "symlink";
    if (isUtf8(file.bytes)) {
      file.encoding = "utf-8";
      file.text = file.bytes.toString("utf8");
    }
    return;
  }
  file.kind = file.entry.logical_path.endsWith("/git-marker.txt")
    ? "git-marker"
    : "topology-marker";
}

function markerEvidence(
  file: LegacyImportDecodedSourceFile | undefined,
  id: string | undefined,
): MarkerEvidence | undefined {
  if (file === undefined || id === undefined) return undefined;
  const match = /^gitdir: ([^\r\n]+)\r?\n?$/u.exec(file.text);
  if (match === null || match[1]!.trim().length === 0) return undefined;
  const parts = match[1]!.split("/").filter((part) => part.length > 0 && part !== "." && part !== "..");
  return { file, id, identity: parts.at(-1) ?? match[1]! };
}

function preserve(
  candidates: LegacyImportPendingCandidate[],
  file: LegacyImportDecodedSourceFile,
  key: string,
  normalized: Parameters<typeof addLegacyImportCandidate>[3],
  reasonCode: string,
): void {
  file.outcome = "preserved";
  addLegacyImportCandidate(
    candidates,
    file,
    { kind: "legacy-worktree-topology", key },
    normalized,
    reasonCode,
    0,
    file.bytes.length,
    "preserve",
  );
}

function diagnoseMalformedMarker(
  file: LegacyImportDecodedSourceFile,
  diagnoses: LegacyImportPendingDiagnosis[],
): void {
  file.outcome = "unparsed";
  addLegacyImportDiagnosis(
    diagnoses,
    file,
    "malformed-git-marker",
    "warning",
    "The worktree marker is malformed and remains preserved as raw evidence.",
    "preserved",
  );
}

function matchingFile(
  group: WorktreeGroup,
  capture: LegacyImportSourceCapture,
  pattern: RegExp,
): { file: LegacyImportDecodedSourceFile; match: RegExpExecArray } | undefined {
  for (const file of group.files) {
    const match = pattern.exec(topologyPath(file, capture));
    if (match !== null) return { file, match };
  }
  return undefined;
}

function matchingFiles(
  group: WorktreeGroup,
  capture: LegacyImportSourceCapture,
  pattern: RegExp,
): Array<{ file: LegacyImportDecodedSourceFile; match: RegExpExecArray }> {
  const matches: Array<{ file: LegacyImportDecodedSourceFile; match: RegExpExecArray }> = [];
  for (const file of group.files) {
    const match = pattern.exec(topologyPath(file, capture));
    if (match !== null) matches.push({ file, match });
  }
  return matches;
}

function physicalLabel(file: LegacyImportDecodedSourceFile): string {
  const parts = file.text.split("/").filter((part) => part.length > 0 && part !== "." && part !== "..");
  return parts.slice(-2).join("-");
}

function contributeMigrationState(
  group: WorktreeGroup,
  capture: LegacyImportSourceCapture,
  candidates: LegacyImportPendingCandidate[],
  diagnoses: LegacyImportPendingDiagnosis[],
): boolean {
  const staging = matchingFile(group, capture, /(?:^|\/)\.gsd\.migrating\/PREFERENCES\.md$/u)?.file;
  if (staging === undefined) return false;
  const current = matchingFile(group, capture, /(?:^|\/)\.gsd\/PREFERENCES\.md$/u)?.file;
  if (current === undefined) {
    preserve(
      candidates,
      staging,
      "interrupted/staging",
      { scenario: "interrupted-migration", role: "migration-staging" },
      "interrupted-staging-preserved-without-recovery",
    );
    addLegacyImportDiagnosis(
      diagnoses,
      staging,
      "interrupted-migration",
      "warning",
      "Migration staging exists without current state and is preserved without automatic recovery during import.",
      "preserved",
    );
    return true;
  }
  preserve(
    candidates,
    current,
    "interrupted-conflict/current",
    { scenario: "interrupted-migration-root-conflict", role: "current-state" },
    "conflicting-current-state-preserved",
  );
  preserve(
    candidates,
    staging,
    "interrupted-conflict/staging",
    { scenario: "interrupted-migration-root-conflict", role: "migration-staging" },
    "conflicting-staging-state-preserved",
  );
  addLegacyImportDiagnosis(
    diagnoses,
    staging,
    "interrupted-migration-root-conflict",
    "blocker",
    "Current and migration-staging roots coexist; neither root is selected automatically.",
    "requires-user",
  );
  return true;
}

function contributeExternalState(
  group: WorktreeGroup,
  capture: LegacyImportSourceCapture,
  candidates: LegacyImportPendingCandidate[],
): boolean {
  const link = matchingFile(group, capture, /(?:^|\/)(?:project\/)?\.gsd$/u)?.file;
  const markerMatches = matchingFiles(
    group,
    capture,
    /(?:^|\/)(?:state|\$GSD_STATE_DIR)\/projects\/([^/]+)\/worktrees\/(M\d+)\/git-marker\.txt$/u,
  );
  if (link?.entry.kind !== "symlink" || markerMatches.length === 0) return false;
  let handled = false;
  for (const markerMatch of markerMatches) {
    const marker = markerEvidence(markerMatch.file, markerMatch.match[2]);
    if (marker === undefined) continue;
    preserve(
      candidates,
      marker.file,
      `external/${marker.id}`,
      {
        scenario: "external",
        id: marker.id,
        project_identity: markerMatch.match[1]!,
        evidence_kind: EVIDENCE_KIND,
      },
      "external-worktree-preserved",
    );
    handled = true;
  }
  if (!handled) return false;
  preserve(
    candidates,
    link,
    "external/project-state-link",
    { scenario: "symlink", target: link.text },
    "external-state-symlink-preserved",
  );
  return true;
}

function contributeDuplicateIdentity(
  group: WorktreeGroup,
  capture: LegacyImportSourceCapture,
  candidates: LegacyImportPendingCandidate[],
  diagnoses: LegacyImportPendingDiagnosis[],
): boolean {
  const canonicalMatches = matchingFiles(group, capture, /(?:^|\/)\.gsd-worktrees\/(M\d+)$/u);
  const legacyMatches = matchingFiles(group, capture, /(?:^|\/)\.gsd\/worktrees\/(M\d+)$/u);
  let handled = false;
  for (const canonical of canonicalMatches) {
    const legacy = legacyMatches.find((candidate) => (
      candidate.match[1] === canonical.match[1]
      && candidate.file.entry.symlink_target_identity === canonical.file.entry.symlink_target_identity
    ));
    if (
      canonical.file.entry.kind !== "symlink"
      || legacy?.file.entry.kind !== "symlink"
    ) {
      continue;
    }
    const id = canonical.match[1]!;
    preserve(
      candidates,
      canonical.file,
      `duplicate-identity/${id}/canonical`,
      {
        scenario: "duplicate-physical-identity",
        id,
        layout: "canonical",
        physical_identity: physicalLabel(canonical.file),
      },
      "canonical-physical-identity-preserved",
    );
    legacy.file.outcome = "ignored-with-reason";
    const target = { kind: "legacy-worktree-topology", key: `duplicate-identity/${id}/canonical` };
    addLegacyImportDiagnosis(
      diagnoses,
      legacy.file,
      "duplicate-physical-identity",
      "info",
      "Canonical and legacy paths resolve to one physical worktree; the legacy alias is ignored in favor of the canonical identity.",
      "mapped",
      0,
      legacy.file.bytes.length,
      target,
    );
    const backingMatch = matchingFile(
      group,
      capture,
      new RegExp(`(?:^|/)shared/${id}/git-marker\\.txt$`, "u"),
    );
    const backing = markerEvidence(backingMatch?.file, id);
    if (backing !== undefined) {
      preserve(
        candidates,
        backing.file,
        `duplicate-identity/${id}/physical`,
        { scenario: "duplicate-physical-identity", id, role: "physical-backing", evidence_kind: EVIDENCE_KIND },
        "physical-backing-preserved",
      );
    }
    handled = true;
  }
  return handled;
}

function contributeStaleCanonical(
  group: WorktreeGroup,
  capture: LegacyImportSourceCapture,
  candidates: LegacyImportPendingCandidate[],
  diagnoses: LegacyImportPendingDiagnosis[],
): boolean {
  const staleMatches = matchingFiles(group, capture, /(?:^|\/)\.gsd-worktrees\/(M\d+)\/README\.txt$/u);
  const legacyMatches = matchingFiles(group, capture, /(?:^|\/)\.gsd\/worktrees\/(M\d+)\/git-marker\.txt$/u);
  let handled = false;
  for (const stale of staleMatches) {
    const id = stale.match[1]!;
    const legacyMatch = legacyMatches.find((candidate) => candidate.match[1] === id);
    if (legacyMatch === undefined) continue;
    const directoryPath = stale.file.entry.logical_path.slice(0, -"/README.txt".length);
    const hasCapturedDirectory = capture.entries.some((entry) => (
      entry.kind === "directory" && entry.logical_path === directoryPath
    ));
    const legacy = markerEvidence(legacyMatch.file, id);
    if (!hasCapturedDirectory || legacy === undefined) continue;
    preserve(
      candidates,
      legacy.file,
      `stale-canonical/${id}/legacy`,
      { scenario: "stale-canonical", id, selected_layout: "legacy", evidence_kind: EVIDENCE_KIND },
      "stale-canonical-does-not-shadow-legacy",
    );
    stale.file.outcome = "ignored-with-reason";
    addLegacyImportDiagnosis(
      diagnoses,
      stale.file,
      "stale-canonical-does-not-shadow-legacy",
      "info",
      "A canonical directory without a git marker is ignored while the live legacy worktree is preserved.",
      "mapped",
      0,
      stale.file.bytes.length,
      { kind: "legacy-worktree-topology", key: `stale-canonical/${id}/legacy` },
    );
    handled = true;
  }
  return handled;
}

function contributeMarkerRoots(
  group: WorktreeGroup,
  capture: LegacyImportSourceCapture,
  candidates: LegacyImportPendingCandidate[],
  diagnoses: LegacyImportPendingDiagnosis[],
): void {
  const canonicalMatches = matchingFiles(group, capture, /(?:^|\/)\.gsd-worktrees\/(M\d+)\/git-marker\.txt$/u);
  const legacyMatches = matchingFiles(group, capture, /(?:^|\/)\.gsd\/worktrees\/(M\d+)\/git-marker\.txt$/u);
  const legacyById = new Map(legacyMatches.map((legacyMatch) => [legacyMatch.match[1]!, legacyMatch]));
  const claimedLegacyIds = new Set<string>();
  for (const canonicalMatch of canonicalMatches) {
    const id = canonicalMatch.match[1]!;
    const canonical = markerEvidence(canonicalMatch.file, id);
    if (canonical === undefined) {
      diagnoseMalformedMarker(canonicalMatch.file, diagnoses);
      continue;
    }
    const legacyMatch = legacyById.get(id);
    if (legacyMatch === undefined) {
      preserve(
        candidates,
        canonical.file,
        `canonical/${canonical.id}`,
        { scenario: "canonical", id: canonical.id, layout: "canonical", active: true, evidence_kind: EVIDENCE_KIND },
        "canonical-worktree-preserved",
      );
      continue;
    }
    claimedLegacyIds.add(id);
    const legacy = markerEvidence(legacyMatch.file, id);
    if (legacy === undefined) {
      diagnoseMalformedMarker(legacyMatch.file, diagnoses);
      preserve(
        candidates,
        canonical.file,
        `canonical/${canonical.id}`,
        { scenario: "canonical", id: canonical.id, layout: "canonical", active: true, evidence_kind: EVIDENCE_KIND },
        "canonical-worktree-preserved",
      );
      continue;
    }
    preserve(
      candidates,
      canonical.file,
      `root-conflict/${canonical.id}/canonical`,
      {
        scenario: "root-conflict",
        id: canonical.id,
        layout: "canonical",
        physical_identity: canonical.identity,
        evidence_kind: EVIDENCE_KIND,
      },
      "conflicting-canonical-root-preserved",
    );
    preserve(
      candidates,
      legacy.file,
      `root-conflict/${legacy.id}/legacy`,
      {
        scenario: "root-conflict",
        id: legacy.id,
        layout: "legacy",
        physical_identity: legacy.identity,
        evidence_kind: EVIDENCE_KIND,
      },
      "conflicting-legacy-root-preserved",
    );
    addLegacyImportDiagnosis(
      diagnoses,
      legacy.file,
      "canonical-legacy-root-conflict",
      "blocker",
      `Canonical and legacy paths for ${legacy.id} have different physical identities; neither root is selected automatically.`,
      "requires-user",
    );
  }
  const remainingLegacy = legacyMatches.filter((legacyMatch) => !claimedLegacyIds.has(legacyMatch.match[1]!));
  if (remainingLegacy.length === 0) return;
  const preferences = matchingFile(group, capture, /(?:^|\/)\.gsd\/PREFERENCES\.md$/u)?.file;
  let preferencesPreserved = false;
  for (const legacyMatch of remainingLegacy) {
    const id = legacyMatch.match[1]!;
    const legacy = markerEvidence(legacyMatch.file, id);
    if (legacy === undefined) {
      diagnoseMalformedMarker(legacyMatch.file, diagnoses);
      continue;
    }
    if (preferences === undefined) {
      preserve(
        candidates,
        legacy.file,
        `legacy/${legacy.id}`,
        { scenario: "legacy", id: legacy.id, layout: "legacy", active: true, evidence_kind: EVIDENCE_KIND },
        "legacy-worktree-preserved",
      );
      continue;
    }
    if (!preferencesPreserved) {
      preserve(
        candidates,
        preferences,
        "active-guard/project-state",
        { scenario: "active-worktree-guard", role: "project-state" },
        "active-project-state-preserved",
      );
      preferencesPreserved = true;
    }
    preserve(
      candidates,
      legacy.file,
      `active-guard/${legacy.id}`,
      { scenario: "active-worktree-guard", id: legacy.id, layout: "legacy", active: true, evidence_kind: EVIDENCE_KIND },
      "active-worktree-preserved-without-migration",
    );
    addLegacyImportDiagnosis(
      diagnoses,
      legacy.file,
      "active-worktree-migration-guard",
      "info",
      "Migration is skipped while a legacy worktree directory is active; the topology is preserved without mutation.",
      "preserved",
    );
  }
}

export function contributeLegacyWorktreeTopology(
  files: readonly LegacyImportDecodedSourceFile[],
  candidates: LegacyImportPendingCandidate[],
  diagnoses: LegacyImportPendingDiagnosis[],
  capture: LegacyImportSourceCapture,
): void {
  const groups = new Map<string, WorktreeGroup>();
  for (const file of files) {
    if (!isWorktreeSurface(file, capture)) continue;
    prepareFile(file);
    const groupKey = topologyGroupKey(file, capture);
    const group = groups.get(groupKey) ?? { files: [] };
    group.files.push(file);
    groups.set(groupKey, group);
  }
  for (const group of groups.values()) {
    if (contributeMigrationState(group, capture, candidates, diagnoses)) continue;
    if (contributeExternalState(group, capture, candidates)) continue;
    if (contributeDuplicateIdentity(group, capture, candidates, diagnoses)) continue;
    if (contributeStaleCanonical(group, capture, candidates, diagnoses)) continue;
    contributeMarkerRoots(group, capture, candidates, diagnoses);
  }
}
