import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeActivityStamp } from "./activity-probe.js";

async function scaffold(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "planf3-activity-"));
}

/** Write a file and pin its mtime (seconds precision is fine for ordering). */
async function touch(path: string, epochSec: number): Promise<void> {
  await writeFile(path, "", "utf8");
  await utimes(path, epochSec, epochSec);
}

describe("makeActivityStamp (F6.0-5 liveness probe — stat-only .gsd carve-out)", () => {
  test("returns the max mtime across present liveness paths", async () => {
    const tmp = await scaffold();
    await mkdir(join(tmp, ".gsd"), { recursive: true });
    await touch(join(tmp, ".gsd", "gsd.db-wal"), 1_000);
    await touch(join(tmp, ".gsd", "notifications.jsonl"), 2_000);
    const stamp = await makeActivityStamp(tmp)();
    assert.equal(stamp, 2_000_000); // mtimeMs
  });

  test("missing paths are skipped, present ones still counted", async () => {
    const tmp = await scaffold();
    await mkdir(join(tmp, ".gsd"), { recursive: true });
    await touch(join(tmp, ".gsd", "gsd.db"), 3_000);
    // no wal/shm/notifications/activity/journal/exec
    const stamp = await makeActivityStamp(tmp)();
    assert.equal(stamp, 3_000_000);
  });

  test("directory mtimes count (entry churn in .gsd/journal is liveness)", async () => {
    const tmp = await scaffold();
    await mkdir(join(tmp, ".gsd", "journal"), { recursive: true });
    await utimes(join(tmp, ".gsd", "journal"), 4_000, 4_000);
    const stamp = await makeActivityStamp(tmp)();
    assert.equal(stamp, 4_000_000);
  });

  test("nothing observable → null (never throws)", async () => {
    const tmp = await scaffold(); // no .gsd at all
    assert.equal(await makeActivityStamp(tmp)(), null);
  });

  test("statFn errors are swallowed per-path; survivors still counted; all-fail → null", async () => {
    const tmp = await scaffold();
    const flaky = async (p: string): Promise<{ mtimeMs: number }> => {
      if (p.endsWith("gsd.db-wal")) return { mtimeMs: 5_000_000 };
      throw new Error("EACCES");
    };
    assert.equal(await makeActivityStamp(tmp, flaky)(), 5_000_000);
    const allFail = async (): Promise<{ mtimeMs: number }> => { throw new Error("EACCES"); };
    assert.equal(await makeActivityStamp(tmp, allFail)(), null);
  });
});
