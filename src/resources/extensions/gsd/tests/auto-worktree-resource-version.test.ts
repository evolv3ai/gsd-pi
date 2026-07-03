import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkResourcesStale,
  readResourceVersion,
} from "../auto-worktree-resource-version.ts";

function withAgentDir<T>(fn: (agentDir: string) => T): T {
  const oldAgentDir = process.env.GSD_CODING_AGENT_DIR;
  const agentDir = mkdtempSync(join(tmpdir(), "gsd-resource-version-"));
  process.env.GSD_CODING_AGENT_DIR = agentDir;
  try {
    return fn(agentDir);
  } finally {
    if (oldAgentDir === undefined) {
      delete process.env.GSD_CODING_AGENT_DIR;
    } else {
      process.env.GSD_CODING_AGENT_DIR = oldAgentDir;
    }
    rmSync(agentDir, { recursive: true, force: true });
  }
}

test("readResourceVersion reads gsdVersion from managed-resources manifest", () => {
  withAgentDir((agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "managed-resources.json"),
      JSON.stringify({ gsdVersion: "1.2.3", syncedAt: "ignored" }),
    );

    assert.equal(readResourceVersion(), "1.2.3");
  });
});

test("checkResourcesStale reports only when resource version changed", () => {
  withAgentDir((agentDir) => {
    writeFileSync(
      join(agentDir, "managed-resources.json"),
      JSON.stringify({ gsdVersion: "2.0.0" }),
    );

    assert.equal(checkResourcesStale(null), null);
    assert.equal(checkResourcesStale("2.0.0"), null);
    assert.equal(
      checkResourcesStale("1.9.0"),
      "GSD resources were updated since this session started. Restart gsd to load the new code.",
    );
  });
});
