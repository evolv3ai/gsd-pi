import assert from "node:assert/strict";

import {
  loadUnboundProjectionEvidence,
  previewUnboundProjectionEvidenceResolution,
  resolveUnboundProjectionEvidence,
} from "../managed-projection-history.js";

export function discardProjectionEvidence(basePath: string): void {
  let evidence;
  try {
    evidence = loadUnboundProjectionEvidence(basePath);
  } catch (error) {
    assert.match((error as Error).message, /kind changed|target identity changed|unexpected occupant/i);
    evidence = loadUnboundProjectionEvidence(basePath);
  }
  for (const item of evidence) {
    const preview = previewUnboundProjectionEvidenceResolution(basePath, item.evidenceId, "discard");
    resolveUnboundProjectionEvidence(basePath, item.evidenceId, "discard", preview.consent);
  }
  assert.deepEqual(loadUnboundProjectionEvidence(basePath), []);
}
