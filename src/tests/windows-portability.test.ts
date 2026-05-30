import test from "node:test";
import assert from "node:assert/strict";
import { encodeCwd } from "../resources/extensions/subagent/isolation.ts";
import { buildGoogleCliSpawnInvocation } from "../resources/extensions/google-cli/stream-adapter.ts";
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
	const plan = buildGoogleCliSpawnInvocation("gemini", ["-p", "hello"], "win32");
	assert.equal(plan.command, "cmd");
	assert.deepEqual(plan.args, ["/c", "gemini", "-p", "hello"]);
});

test("Google CLI spawn plan keeps direct execution on non-Windows platforms", () => {
	const plan = buildGoogleCliSpawnInvocation("agy", ["-p", "hello"], "linux");
	assert.equal(plan.command, "agy");
	assert.deepEqual(plan.args, ["-p", "hello"]);
});
