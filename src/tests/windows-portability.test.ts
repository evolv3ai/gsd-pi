import test from "node:test";
import assert from "node:assert/strict";
import { encodeCwd } from "../resources/extensions/subagent/isolation.ts";
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
