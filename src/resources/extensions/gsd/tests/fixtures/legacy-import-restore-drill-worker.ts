// Project/App: gsd-pi
// File Purpose: True-termination worker for isolated legacy backup restore-drill restart tests.

import { chmodSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { _drillLegacyImportBackupRestoreForTest } from "../../legacy-import-restore-drill.ts";
import type { LegacyImportVerifiedBackup } from "../../legacy-import-backup.ts";
import type { LegacyImportBaseSnapshot } from "../../legacy-import-preview-base.ts";
import type { LegacyImportPreviewArtifact } from "../../legacy-import-preview.ts";

interface WorkerInput {
  input: {
    backup: LegacyImportVerifiedBackup;
    preview: LegacyImportPreviewArtifact;
    base: LegacyImportBaseSnapshot;
  };
  drillParent: string;
  boundary: string;
}

function terminate(): never {
  process.kill(process.pid, "SIGKILL");
  throw new Error("SIGKILL did not terminate the restore drill worker");
}

const input = JSON.parse(readFileSync(0, "utf8")) as WorkerInput;
_drillLegacyImportBackupRestoreForTest(input.input, {
  makeDrillDirectory() {
    const path = realpathSync(mkdtempSync(join(input.drillParent, ".restore-drill-")));
    chmodSync(path, 0o700);
    return path;
  },
  boundary(name) {
    if (name === input.boundary) terminate();
  },
});
