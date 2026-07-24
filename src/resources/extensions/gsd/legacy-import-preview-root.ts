// Project/App: gsd-pi
// File Purpose: Pure legacy repository-root projection contributions from retained source bytes.

import {
  addLegacyImportCandidate,
  type LegacyImportDecodedSourceFile,
  type LegacyImportPendingCandidate,
} from "./legacy-import-preview-interpretation.js";

interface RootProjection {
  role: string;
  reasonCode: string;
}

const ROOT_PROJECTIONS: Readonly<Record<string, RootProjection>> = {
  ".gsd/PROJECT.md": {
    role: "readable-status-projection",
    reasonCode: "root-project-projection-preserved",
  },
  ".gsd/QUEUE.md": {
    role: "database-queue-projection",
    reasonCode: "root-queue-projection-preserved",
  },
};

// Heuristic limits: "sanitized" only means the manifest carries the known
// no-credentials boilerplate AND shows no unambiguous secret material
// (private-key blocks or well-known API token formats). This is not a secrets
// scanner: prose credentials in other formats still pass, so
// contains_secrets:false records the manifest's self-description and must
// never be treated as proof that no secrets are present.
const SECRET_MATERIAL_PATTERN = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{20,}/u;

function isSanitizedSecretsManifest(text: string): boolean {
  return /No credential material is included/iu.test(text)
    && /Required environment keys:\s*none/iu.test(text)
    && !SECRET_MATERIAL_PATTERN.test(text);
}

export function contributeLegacyRootProjections(
  files: readonly LegacyImportDecodedSourceFile[],
  candidates: LegacyImportPendingCandidate[],
): void {
  for (const file of files) {
    const path = file.entry.logical_path;
    const projection = ROOT_PROJECTIONS[path];
    if (projection !== undefined && file.encoding === "utf-8") {
      file.parserId = "gsd-artifact-classifier";
      file.kind = "markdown";
      file.outcome = "preserved";
      addLegacyImportCandidate(
        candidates,
        file,
        { kind: "artifact", key: path },
        { path, preservation: "verbatim", role: projection.role },
        projection.reasonCode,
        0,
        file.bytes.length,
        "preserve",
      );
      continue;
    }
    if (path !== ".gsd/SECRETS-MANIFEST.md" || file.encoding !== "utf-8") continue;
    file.parserId = "gsd-artifact-classifier";
    file.kind = "markdown";
    file.outcome = "preserved";
    const sanitized = isSanitizedSecretsManifest(file.text);
    addLegacyImportCandidate(
      candidates,
      file,
      { kind: "artifact", key: path },
      {
        ...(sanitized ? { contains_secrets: false } : {}),
        path,
        preservation: "verbatim",
        role: sanitized ? "sanitized-manifest" : "secrets-manifest",
      },
      sanitized ? "sanitized-secrets-manifest-preserved" : "secrets-manifest-preserved",
      0,
      file.bytes.length,
      "preserve",
    );
  }
}
