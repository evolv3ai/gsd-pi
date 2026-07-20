import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPreflight, signOffPreflight, type PreflightDeps } from "./run.js";
import { issueApprovalToken } from "./approval-token.js";
import type { Spawner } from "../gsd/headless-runner.js";

const PLAN_HTML = `<html><body><header><h1>P</h1></header>
<section id="validation"><ul class="checklist"><li><code class="status">[]</code> <code>pnpm typecheck</code></li></ul></section>
<section id="model-policy"><dl><dt>planning</dt><dd>claude-code/claude-fable-5</dd></dl></section>
<section id="integrations"><ul><li><strong>Neon</strong> — <code>DATABASE_URL</code></li></ul></section>
</body></html>`;

async function scaffold(): Promise<{ tmp: string; html: string }> {
  const tmp = await mkdtemp(join(tmpdir(), "planf3-run-"));
  await mkdir(join(tmp, "specs"), { recursive: true });
  const html = join(tmp, "specs", "p.html");
  await writeFile(html, PLAN_HTML, "utf8");
  await writeFile(join(tmp, "global-prefs.md"), "---\nversion: 1\nmodels:\n  execution: claude-code/claude-sonnet-4-6\n---\n", "utf8");
  return { tmp, html };
}

function deps(tmp: string, html: string | null, spawnedOk = true): PreflightDeps {
  const spawn: Spawner = async (cmd) => {
    if (cmd === "claude") return { exitCode: 0, stdout: '{"loggedIn":true}', stderr: "" };
    if (cmd === "gsd") return { exitCode: 0, stdout: "gsd 1.6.0", stderr: "" };
    if (cmd === "git") return { exitCode: 0, stdout: "main\n", stderr: "" };
    return { exitCode: spawnedOk ? 0 : 1, stdout: "", stderr: "" };
  };
  return {
    projectRoot: tmp,
    htmlPath: html,
    offline: false,
    ping: false,
    catalog: { ids: () => ["claude-code/claude-fable-5", "claude-code/claude-sonnet-4-6"] },
    orchestrator: { host: "claude-code", model: "claude-code/claude-fable-5", authMode: "subscription", skills: ["planf3"] },
    spawn,
    env: {},
    now: () => "2026-07-06T07:00:00Z",
    globalPrefsPath: join(tmp, "global-prefs.md"),
  };
}

describe("runPreflight", () => {
  test("assembles projection-scoped map; unapproved without a record; rendered ends with verdict line", async () => {
    const { tmp, html } = await scaffold();
    const run = await runPreflight(deps(tmp, html));
    assert.equal(run.verdict, "unapproved");
    assert.deepEqual(run.map.projection.buckets, {
      planning: "claude-code/claude-fable-5",
      execution: "claude-code/claude-sonnet-4-6",
    });
    // projection-scoped probing: only claude-code probed (both buckets resolve to it)
    assert.deepEqual([...new Set(run.map.probes.map((p) => p.target))], ["claude-code"]);
    assert.equal(run.map.product[0].service, "Neon");
    assert.equal(run.map.product[0].envVars[0].name, "DATABASE_URL");
    assert.equal(run.map.product[0].injectionDisclaimer, true);
    // no .manifest.json exported yet → the wiring check says so (spec §6.1)
    assert.ok(run.map.validationIssues.some((i) => i.includes("not exported yet")));
    const lines = run.rendered.trimEnd().split("\n");
    assert.equal(lines[lines.length - 1], "preflight: verdict=unapproved");
  });

  test("offline skips probes entirely", async () => {
    const { tmp, html } = await scaffold();
    const run = await runPreflight({ ...deps(tmp, html), offline: true });
    assert.deepEqual(run.map.probes, []);
  });

  test("sign-off WITHOUT a human approval token is refused and writes nothing (F5.1-2)", async () => {
    const { tmp, html } = await scaffold();
    const d = deps(tmp, html);
    await assert.rejects(signOffPreflight(d, "agent says trust me", null), /approval token/);
    await assert.rejects(readFile(join(tmp, "specs", "PRESETS.md"), "utf8"), "no PRESETS record may exist");
  });

  test("sign-off with a WRONG token is refused, pending stays valid for the human (F5.1-2)", async () => {
    const { tmp, html } = await scaffold();
    const d = deps(tmp, html);
    const probe = await runPreflight(d);
    await issueApprovalToken(tmp, probe.approvalHash, { now: () => new Date("2026-07-06T07:00:00Z"), projectedFrom: html });
    await assert.rejects(signOffPreflight(d, null, "0000000000"), /does not match/);
    await assert.rejects(readFile(join(tmp, "specs", "PRESETS.md"), "utf8"));
    // the real token still works afterwards
    const token2 = await issueApprovalToken(tmp, probe.approvalHash, { now: () => new Date("2026-07-06T07:00:00Z"), projectedFrom: html });
    const { path } = await signOffPreflight(d, null, token2);
    assert.equal(path, join(tmp, "specs", "PRESETS.md"));
  });

  test("sign-off with a STALE-MAP token (map changed since issue) is refused (F5.1-2)", async () => {
    const { tmp, html } = await scaffold();
    const d = deps(tmp, html);
    await issueApprovalToken(tmp, "0".repeat(64), { now: () => new Date("2026-07-06T07:00:00Z"), projectedFrom: html });
    await assert.rejects(signOffPreflight(d, null, "anytoken00"), /does not match|changed since/);
  });

  test("sign-off writes PRESETS.md; a re-run is then ok; an out-of-band edit drifts", async () => {
    const { tmp, html } = await scaffold();
    const d = deps(tmp, html);
    const probe = await runPreflight(d);
    const token = await issueApprovalToken(tmp, probe.approvalHash, { now: () => new Date("2026-07-06T07:00:00Z"), projectedFrom: html });
    const { path, approvalHash } = await signOffPreflight(d, "first approval", token);
    assert.equal(path, join(tmp, "specs", "PRESETS.md"));
    assert.match(await readFile(path, "utf8"), /first approval/);

    const again = await runPreflight(d);
    assert.equal(again.verdict, "ok");
    assert.equal(again.approvalHash, approvalHash);

    // Drift must touch a bucket the plan's OWN policy does NOT govern — the
    // projection re-applies plan policy, so editing `planning` here would be
    // masked (the plan sets planning). `execution` comes from global prefs.
    await mkdir(join(tmp, ".gsd"), { recursive: true });
    await writeFile(join(tmp, ".gsd", "PREFERENCES.md"), "---\nversion: 1\nmodels:\n  execution: claude-code/claude-haiku-4-5\n---\n", "utf8");
    const drifted = await runPreflight(d);
    assert.equal(drifted.verdict, "drift");
    assert.deepEqual(drifted.drift[0], {
      kind: "config", field: "buckets.execution",
      approved: "claude-code/claude-sonnet-4-6", current: "claude-code/claude-haiku-4-5",
    });
  });

  test("F1: sign-off with absolute htmlPath is accepted on re-run with the equivalent relative path", async () => {
    const { tmp, html } = await scaffold();
    // Sign with the ABSOLUTE path (this is what the tool caller in the e2e did).
    const dAbs = deps(tmp, html);
    const probeAbs = await runPreflight(dAbs);
    const tokenAbs = await issueApprovalToken(tmp, probeAbs.approvalHash, { now: () => new Date("2026-07-06T07:00:00Z"), projectedFrom: html });
    await signOffPreflight(dAbs, "signed with abs", tokenAbs);

    // Re-run with the EQUIVALENT RELATIVE path (the argv shape of a slash command).
    const relative = join("specs", "p.html");
    const dRel = deps(tmp, relative);
    const again = await runPreflight(dRel);
    assert.equal(again.verdict, "ok", "same file, resolved identically at the deps boundary");
  });
});

describe("exit-code contract (spec §11.10)", () => {
  test("verdict → exit code mapping table", async () => {
    const { EXIT_CODES } = await import("../commands/preflight-register.js");
    assert.deepEqual(EXIT_CODES, { ok: 0, unapproved: 20, drift: 21, error: 1 });
  });
});

describe("sign-off path binding (F6.0-6)", () => {
  test("bare sign-off of a path-scoped token refuses with the full projected command, token survives", async () => {
    const { tmp, html } = await scaffold();
    const probe = await runPreflight(deps(tmp, html));
    const token = await issueApprovalToken(tmp, probe.approvalHash, { now: () => new Date("2026-07-06T07:00:00Z"), projectedFrom: html });
    // bare deps: same project, NO htmlPath
    await assert.rejects(
      signOffPreflight(deps(tmp, null), null, token),
      (err: Error) => {
        assert.match(err.message, /minted for a projected map/);
        assert.ok(err.message.includes(`specs/p.html --sign-off ${token}`), `retry hint must carry path + token: ${err.message}`);
        return true;
      },
    );
    // token survived the refusal — the projected sign-off still works
    const { path } = await signOffPreflight(deps(tmp, html), null, token);
    assert.equal(path, join(tmp, "specs", "PRESETS.md"));
  });

  test("projected sign-off of a bare token refuses and names the bare retry", async () => {
    const { tmp, html } = await scaffold();
    const probe = await runPreflight(deps(tmp, null));
    const token = await issueApprovalToken(tmp, probe.approvalHash, { now: () => new Date("2026-07-06T07:00:00Z") });
    await assert.rejects(
      signOffPreflight(deps(tmp, html), null, token),
      /minted for the bare map/,
    );
  });
});
