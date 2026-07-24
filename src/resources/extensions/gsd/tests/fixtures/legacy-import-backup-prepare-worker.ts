// Project/App: gsd-pi
// File Purpose: True-termination worker for legacy backup publication restart tests.

import { linkSync } from "node:fs";

import {
  _prepareLegacyImportBackupForTest,
  createLegacyImportBackupSnapshot,
  prepareLegacyImportBackupPreflight,
  verifyLegacyImportBackupSnapshot,
  type LegacyImportBackupPreflightInput,
} from "../../legacy-import-backup.ts";
import { closeDatabase, openDatabase } from "../../gsd-db.ts";
import { revalidateLegacyImportPreview } from "../../legacy-import-preview.ts";
import { openSqliteReadOnly } from "../../sqlite-readonly.ts";

interface WorkerInput {
  databasePath: string;
  preparationInput: LegacyImportBackupPreflightInput;
  boundary: "after-verification" | "after-publish";
}

function terminate(): never {
  process.kill(process.pid, "SIGKILL");
  throw new Error("SIGKILL did not terminate the legacy backup worker");
}

function main(): void {
  const encoded = process.argv.at(-1);
  if (encoded === undefined) throw new Error("legacy backup worker requires one JSON input");
  const input = JSON.parse(encoded) as WorkerInput;
  if (!openDatabase(input.databasePath)) throw new Error("legacy backup worker could not open its database");
  try {
    _prepareLegacyImportBackupForTest(input.preparationInput, {
      preparePreflight: prepareLegacyImportBackupPreflight,
      createSnapshot: createLegacyImportBackupSnapshot,
      verifySnapshot(verificationInput) {
        const verified = verifyLegacyImportBackupSnapshot(verificationInput);
        if (input.boundary === "after-verification") terminate();
        return verified;
      },
      revalidatePreview: revalidateLegacyImportPreview,
      openReadOnly: openSqliteReadOnly,
      now: () => "2026-07-16T12:34:56.789Z",
      link(stagingPath, finalPath) {
        linkSync(stagingPath, finalPath);
        if (input.boundary === "after-publish") terminate();
      },
    });
  } finally {
    closeDatabase();
  }
}

main();
