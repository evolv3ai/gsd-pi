import test from "node:test";
import assert from "node:assert/strict";
import { encodeCwd } from "../resources/extensions/subagent/isolation.ts";
import { buildGoogleCliRunPlan, buildGoogleCliSpawnInvocation } from "../resources/extensions/google-cli/stream-adapter.ts";
import { buildGsdClientSpawnPlan } from "../../vscode-extension/src/gsd-client-spawn.ts";

test("encodeCwd produces a filesystem-safe token for Windows paths", () => {
	const encoded = encodeCwd("C:\\Users\\Alice\\repo");
	assert.match(encoded, /^[A-Za-z0-9_-]+$/);
	assert.ok(!encoded.includes(":"));
	assert.ok(!encoded.includes("\\"));
	assert.ok(!encoded.includes("/"));
});

test("VS Code RPC launch plan uses shell mode for Windows command shims", () => {
	const plan = buildGsdClientSpawnPlan("gsd.cmd", "C:\\repo", { PATH: "C:\\Windows\\System32" }, "win32");
	assert.equal(plan.command, "gsd.cmd");
	assert.deepEqual(plan.args, ["--mode", "rpc"]);
	assert.equal(plan.options.cwd, "C:\\repo");
	assert.equal(plan.options.shell, true);
	assert.equal(plan.options.env.PATH, "C:\\Windows\\System32");
});

test("Google CLI spawn plan uses cmd.exe on Windows command shims", () => {
	const plan = buildGoogleCliSpawnInvocation("gemini", ["--output-format", "json"], "win32");
	assert.equal(plan.command, "cmd");
	assert.deepEqual(plan.args, ["/c", "gemini", "--output-format", "json"]);
});

test("Google CLI spawn plan keeps direct execution on non-Windows platforms", () => {
	const plan = buildGoogleCliSpawnInvocation("agy", ["-p", "hello"], "linux");
	assert.equal(plan.command, "agy");
	assert.deepEqual(plan.args, ["-p", "hello"]);
});

test("Google CLI run plan pipes prompt on Windows to avoid command-line length limits", () => {
	const prompt = "hello ".repeat(10_000);
	const plan = buildGoogleCliRunPlan("google-gemini-cli", "gemini-2.5-pro", prompt, "win32");
	const antigravityPlan = buildGoogleCliRunPlan("google-antigravity", "default", prompt, "win32");

	assert.equal(plan.command, "cmd");
	assert.deepEqual(plan.args, ["/c", "gemini", "-m", "gemini-2.5-pro", "--output-format", "json"]);
	assert.equal(plan.stdin, prompt);
	assert.ok(!plan.args.some((arg) => arg.includes(prompt)));
	assert.deepEqual(antigravityPlan, { command: "cmd", args: ["/c", "agy"], stdin: prompt });
});

test("Google CLI run plan passes prompt as -p arg on non-Windows platforms", () => {
	const prompt = "hello ".repeat(10_000);
	const plan = buildGoogleCliRunPlan("google-gemini-cli", "gemini-2.5-pro", prompt, "linux");
	const antigravityPlan = buildGoogleCliRunPlan("google-antigravity", "default", prompt, "linux");

	assert.equal(plan.command, "gemini");
	assert.ok(plan.args.includes("-p"));
	assert.ok(plan.args.includes(prompt));
	assert.equal(plan.stdin, undefined);
	assert.equal(antigravityPlan.command, "agy");
	assert.ok(antigravityPlan.args.includes("-p"));
	assert.ok(antigravityPlan.args.includes(prompt));
	assert.equal(antigravityPlan.stdin, undefined);
});
