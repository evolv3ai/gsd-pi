import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { BgProcess } from "../types.ts";
import { analyzeLine, generateDigest, getHighlights } from "../output-formatter.ts";
import { transitionToReady, probePort } from "../readiness-detector.ts";

function makeBg(overrides: Partial<BgProcess> = {}): BgProcess {
  return {
    id: "bg-1",
    label: "test",
    command: "npm test",
    cwd: "/tmp",
    ownerSessionFile: null,
    persistAcrossSessions: false,
    startedAt: Date.now() - 1000,
    proc: {} as BgProcess["proc"],
    output: [],
    exitCode: null,
    signal: null,
    alive: true,
    lastReadIndex: 0,
    processType: "server",
    status: "starting",
    ports: [],
    urls: [],
    recentErrors: [],
    recentWarnings: [],
    events: [],
    lastErrorCount: 0,
    lastWarningCount: 0,
    readyPattern: null,
    readyPort: null,
    wasReady: false,
    group: null,
    stdoutLineCount: 0,
    stderrLineCount: 0,
    restartCount: 0,
    startConfig: {
      command: "npm test",
      cwd: "/tmp",
      label: "test",
      processType: "server",
      ownerSessionFile: null,
      persistAcrossSessions: false,
      readyPattern: null,
      readyPort: null,
      group: null,
    },
    ...overrides,
  };
}

describe("bg-shell readiness-detector", () => {
  test("transitionToReady marks process ready and records event", () => {
    const bg = makeBg();
    transitionToReady(bg, "Listening on port 3000");
    assert.equal(bg.status, "ready");
    assert.equal(bg.wasReady, true);
    assert.equal(bg.events.at(-1)?.type, "ready");
  });

  test("probePort returns false for closed port", async () => {
    const open = await probePort(1);
    assert.equal(open, false);
  });
});

describe("bg-shell output-formatter", () => {
  test("analyzeLine extracts URLs and ports while starting", () => {
    const bg = makeBg();
    analyzeLine(bg, "Server ready at http://127.0.0.1:4567/home", "stdout");
    assert.deepEqual(bg.urls, ["http://127.0.0.1:4567/home"]);
    assert.deepEqual(bg.ports, [4567]);
    assert.equal(bg.status, "ready");
  });

  test("analyzeLine moves ready process to error on stderr pattern", () => {
    const bg = makeBg({ status: "ready" });
    analyzeLine(bg, "Error: fatal crash", "stderr");
    assert.equal(bg.status, "error");
    assert.ok(bg.recentErrors.length > 0);
  });

  test("generateDigest summarizes new output without mutating counters by default", () => {
    const bg = makeBg({
      status: "ready",
      output: [{ stream: "stdout", line: "line-1", ts: Date.now() }],
      recentErrors: ["boom"],
      lastErrorCount: 0,
      lastReadIndex: 0,
    });
    const digest = generateDigest(bg, false);
    assert.match(digest.changeSummary, /1 new lines/);
    assert.equal(bg.lastErrorCount, 0);
  });

  test("getHighlights prefers significant lines", () => {
    const bg = makeBg({
      output: [
        { stream: "stdout", line: "noise", ts: 1 },
        { stream: "stderr", line: "Error: something failed", ts: 2 },
      ],
    });
    const highlights = getHighlights(bg, 5);
    assert.ok(highlights.some((line) => line.includes("Error")));
  });
});
