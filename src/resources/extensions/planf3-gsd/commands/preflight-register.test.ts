import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { registerPreflightCommand, parsePreflightArgs } from "./preflight-register.js";
import { consumeApprovalToken, pendingApprovalPath } from "../preflight/approval-token.js";
import { runPreflight } from "../preflight/run.js";

interface CapturedCommand {
  handler: (args: string, ctx: unknown) => Promise<void>;
}

function captureCommand(): CapturedCommand {
  let cmd: CapturedCommand | undefined;
  const pi = {
    registerCommand(_name: string, c: CapturedCommand) {
      cmd = c;
    },
  } as unknown as ExtensionAPI;
  registerPreflightCommand(pi);
  assert.ok(cmd, "command registered");
  return cmd!;
}

const CATALOG_IDS = ["claude-code/claude-fable-5", "claude-code/claude-sonnet-4-6"];

function ctxFor(tmp: string, sink: string[]): unknown {
  return {
    cwd: tmp,
    model: undefined,
    modelRegistry: {
      getAvailable: () => CATALOG_IDS.map((id) => {
        const slash = id.indexOf("/");
        return { provider: id.slice(0, slash), id: id.slice(slash + 1) };
      }),
      getProviderAuthMode: () => "subscription",
    },
    hasUI: true,
    ui: {
      notify(message: string) {
        sink.push(message);
      },
    },
  };
}

async function scaffold(): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), "planf3-pfcmd-"));
  await mkdir(join(tmp, "specs"), { recursive: true });
  return tmp;
}

function tokenFrom(output: string): string {
  const m = output.match(/approval token: ([a-z0-9]{10})/);
  assert.ok(m, `expected an approval-token line in:\n${output}`);
  return m![1];
}

describe("parsePreflightArgs", () => {
  test("empty → defaults", () => {
    assert.deepEqual(parsePreflightArgs(""), { htmlPath: null, offline: false, ping: false, check: false, asJson: false, signOffToken: null });
  });
  test("path and flags in any order", () => {
    assert.deepEqual(parsePreflightArgs("specs/p.html --offline --check"), { htmlPath: "specs/p.html", offline: true, ping: false, check: true, asJson: false, signOffToken: null });
    assert.deepEqual(parsePreflightArgs("--json specs/p.html"), { htmlPath: "specs/p.html", offline: false, ping: false, check: false, asJson: true, signOffToken: null });
  });
  test("--sign-off consumes the next token as the approval token (not as htmlPath)", () => {
    assert.deepEqual(parsePreflightArgs("--sign-off abc123def0"), { htmlPath: null, offline: false, ping: false, check: false, asJson: false, signOffToken: "abc123def0" });
    assert.deepEqual(parsePreflightArgs("specs/p.html --sign-off abc123def0"), { htmlPath: "specs/p.html", offline: false, ping: false, check: false, asJson: false, signOffToken: "abc123def0" });
  });
  test("--sign-off without a value yields empty token (refused downstream)", () => {
    assert.deepEqual(parsePreflightArgs("--sign-off"), { htmlPath: null, offline: false, ping: false, check: false, asJson: false, signOffToken: "" });
  });
});

describe("preflight command sign-off flow (F5.1-2)", () => {
  test("unapproved console run prints an approval token above the verdict trailer and persists the pending record", async () => {
    const tmp = await scaffold();
    const sink: string[] = [];
    await captureCommand().handler("--offline", ctxFor(tmp, sink));
    const out = sink.join("\n");
    const token = tokenFrom(out);
    const lines = out.trimEnd().split("\n");
    assert.equal(lines[lines.length - 1], "preflight: verdict=unapproved", "verdict stays the LAST line (machine channel)");
    await access(pendingApprovalPath(tmp));
    // the printed token is the live one
    const run = await runPreflight({ projectRoot: tmp, htmlPath: null, offline: true, ping: false, catalog: { ids: () => CATALOG_IDS }, orchestrator: null });
    assert.equal(await consumeApprovalToken(tmp, token, run.approvalHash), "ok");
  });

  test("--sign-off with the printed token signs off; a following run is ok and prints NO token", async () => {
    const tmp = await scaffold();
    const sink: string[] = [];
    const cmd = captureCommand();
    await cmd.handler("--offline", ctxFor(tmp, sink));
    const token = tokenFrom(sink.join("\n"));

    const sink2: string[] = [];
    await cmd.handler(`--offline --sign-off ${token}`, ctxFor(tmp, sink2));
    assert.match(sink2.join("\n"), /Signed off/);
    await access(join(tmp, "specs", "PRESETS.md"));
    assert.match(await readFile(join(tmp, "specs", "PRESETS.md"), "utf8"), /approvedAt/);

    const sink3: string[] = [];
    await cmd.handler("--offline", ctxFor(tmp, sink3));
    const out3 = sink3.join("\n");
    assert.match(out3, /verdict=ok/);
    assert.ok(!/approval token:/.test(out3), "approved map needs no token");
  });

  test("--sign-off with a wrong token refuses and leaves no PRESETS record", async () => {
    const tmp = await scaffold();
    const sink: string[] = [];
    const cmd = captureCommand();
    await cmd.handler("--offline", ctxFor(tmp, sink));
    const sink2: string[] = [];
    await cmd.handler("--offline --sign-off 0000000000", ctxFor(tmp, sink2));
    assert.match(sink2.join("\n"), /does not match/);
    await assert.rejects(access(join(tmp, "specs", "PRESETS.md")));
  });
});

describe("sign-off hint echoes the projection path (F6.0-6)", () => {
  const MINIMAL_PLAN = `<html><body><header><h1>P</h1></header>
<section id="validation"><ul class="checklist"><li><code class="status">[]</code> <code>pnpm test</code></li></ul></section>
<section id="model-policy"><dl><dt>planning</dt><dd>claude-code/claude-fable-5</dd></dl></section>
</body></html>`;

  test("projected unapproved run: hint carries the html path exactly as typed, pending scope is the RESOLVED path", async () => {
    const tmp = await scaffold();
    await writeFile(join(tmp, "specs", "p.html"), MINIMAL_PLAN, "utf8");
    const sink: string[] = [];
    await captureCommand().handler("specs/p.html --offline", ctxFor(tmp, sink));
    const out = sink.join("\n");
    const token = tokenFrom(out);
    assert.ok(out.includes(`/planf3-gsd-preflight specs/p.html --sign-off ${token}`), `hint must echo the typed path:\n${out}`);
    const pending = JSON.parse(await readFile(pendingApprovalPath(tmp), "utf8")) as { projectedFrom: string | null };
    assert.equal(pending.projectedFrom, join(tmp, "specs", "p.html"));
  });

  test("bare unapproved run: hint has no path (unchanged wording)", async () => {
    const tmp = await scaffold();
    const sink: string[] = [];
    await captureCommand().handler("--offline", ctxFor(tmp, sink));
    const token = tokenFrom(sink.join("\n"));
    assert.ok(sink.join("\n").includes(`/planf3-gsd-preflight --sign-off ${token}`));
    const pending = JSON.parse(await readFile(pendingApprovalPath(tmp), "utf8")) as { projectedFrom: string | null };
    assert.equal(pending.projectedFrom, null);
  });

  test("projected mint → projected console sign-off round-trips green", async () => {
    const tmp = await scaffold();
    await writeFile(join(tmp, "specs", "p.html"), MINIMAL_PLAN, "utf8");
    const sink: string[] = [];
    const cmd = captureCommand();
    await cmd.handler("specs/p.html --offline", ctxFor(tmp, sink));
    const token = tokenFrom(sink.join("\n"));
    const sink2: string[] = [];
    await cmd.handler(`specs/p.html --offline --sign-off ${token}`, ctxFor(tmp, sink2));
    assert.match(sink2.join("\n"), /Signed off/);
  });
});
