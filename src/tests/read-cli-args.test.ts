import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runReadCli } from "../read-cli.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(__dirname, "../../integrations/hermes/tests/fixtures/minimal-project");

test("runReadCli handles global flags before read", async () => {
	const stdout = captureWrite(process.stdout);
	const stderr = captureWrite(process.stderr);
	try {
		const exitCode = await runReadCli([
			"node",
			"gsd",
			"--model",
			"claude-sonnet",
			"read",
			"progress",
			"--json",
			"--project",
			fixture,
		]);

		assert.equal(exitCode, 0, stderr.output());
		const envelope = JSON.parse(stdout.output());
		assert.equal(envelope.kind, "progress");
		assert.equal(envelope.projectDir, fixture);
	} finally {
		stdout.restore();
		stderr.restore();
	}
});

function captureWrite(stream: NodeJS.WriteStream): { output: () => string; restore: () => void } {
	const chunks: string[] = [];
	const original = stream.write.bind(stream);
	stream.write = ((chunk: string | Uint8Array) => {
		chunks.push(String(chunk));
		return true;
	}) as typeof stream.write;
	return {
		output: () => chunks.join(""),
		restore: () => {
			stream.write = original;
		},
	};
}
