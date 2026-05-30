import assert from "node:assert/strict";
import test from "node:test";

test("audit:test-matrix strict passes after P0 extension backfill", async () => {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, ["scripts/audit-test-matrix.mjs", "--strict"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || "matrix strict failed");
});
