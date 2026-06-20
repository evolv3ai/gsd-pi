/**
 * async-bash-cancel.test.ts — Tests for graceful async_bash cancellation.
 *
 * Proves that:
 *   1. The killProcessTree re-export from @gsd/pi-coding-agent resolves correctly
 *      (loading async-bash-tool.ts will fail at import-time if the export is missing).
 *   2. manager.cancel() sets status to 'cancelled' and returns 'cancelled'.
 *   3. The job promise settles promptly (SIGTERM kills a well-behaved child).
 *   4. The timeout path force-kills a SIGTERM-immune child via SIGKILL (regression:
 *      it must not be left running in the background after the timeout fires).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAsyncBashTool } from "./async-bash-tool.ts";
import { createAwaitTool } from "./await-tool.ts";
import { AsyncJobManager } from "./job-manager.ts";

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0); // signal 0 probes existence without killing
		return true;
	} catch {
		return false;
	}
}

// If killProcessTree is missing from the re-export the import above will throw
// at load time (async-bash-tool.ts destructures it from @gsd/pi-coding-agent).
// A load-time error surfaces as a test runner parse failure — no explicit
// assertion needed; the test file simply won't run.

const noopSignal = new AbortController().signal;

test("graceful cancel: manager.cancel returns 'cancelled' and job settles promptly", async () => {
	const manager = new AsyncJobManager();
	const tool = createAsyncBashTool(() => manager, () => process.cwd());

	// Launch a long-running well-behaved process (responds to SIGTERM)
	const result = await tool.execute(
		"tc-cancel-01",
		{
			command: "sleep 30",
			label: "cancel-test-sleep",
		},
		noopSignal,
		() => {},
		undefined as never,
	);

	const text = result.content.map((c: { type: string; text?: string }) => c.text ?? "").join("\n");
	const jobId = text.match(/\*\*(bg_[a-f0-9]+)\*\*/)?.[1];
	assert.ok(jobId, `Expected a job ID in result text, got: ${text}`);

	const job = manager.getJob(jobId)!;
	assert.ok(job, "Job should be registered in manager");
	assert.equal(job.status, "running", "Job should be running before cancel");

	// Cancel — should return 'cancelled' immediately
	const cancelResult = manager.cancel(jobId);
	assert.equal(cancelResult, "cancelled", `cancel() should return 'cancelled', got: ${cancelResult}`);
	assert.equal(job.status, "cancelled", "Job status should flip to 'cancelled'");

	// Job promise should settle promptly — SIGTERM kills sleep quickly
	const start = Date.now();
	await Promise.race([
		job.promise,
		new Promise<never>((_, reject) => {
			const t = setTimeout(() => {
				reject(new Error(
					`Job promise did not settle within 5s after cancel ` +
					`(${Date.now() - start}ms elapsed) — graceful cancel may be broken`,
				));
			}, 5_000);
			if (typeof t === "object" && "unref" in t) t.unref();
		}),
	]);

	const elapsed = Date.now() - start;
	assert.ok(elapsed < 5_000, `Job promise should settle under 5s, took ${elapsed}ms`);

	manager.shutdown();
});

test(
	"graceful cancel: status STAYS 'cancelled' after the job promise settles (not clobbered to 'completed')",
	async (t) => {
		// Regression: async_bash resolves (not rejects) its run promise even when aborted —
		// safeResolve returns "Command aborted" rather than throwing — so the job-manager
		// .then branch used to overwrite status back to 'completed', mislabeling a job the
		// user explicitly cancelled. A cancelled job must also deliver NO follow-up.
		const delivered: string[] = [];
		const manager = new AsyncJobManager({ onJobComplete: (j) => delivered.push(j.id) });
		// Tear down via t.after() so a thrown assertion still cleans up the manager.
		t.after(() => manager.shutdown());
		const tool = createAsyncBashTool(() => manager, () => process.cwd());

		const result = await tool.execute(
			"tc-cancel-status",
			{ command: "sleep 30", label: "cancel-status-test" },
			noopSignal,
			() => {},
			undefined as never,
		);
		const text = result.content.map((c: { type: string; text?: string }) => c.text ?? "").join("\n");
		const jobId = text.match(/\*\*(bg_[a-f0-9]+)\*\*/)?.[1];
		assert.ok(jobId, `Expected a job ID, got: ${text}`);

		const job = manager.getJob(jobId)!;
		assert.equal(manager.cancel(jobId), "cancelled");
		assert.equal(job.status, "cancelled", "status should be 'cancelled' synchronously");

		// Await the run promise settling (SIGTERM kills sleep quickly), THEN re-check status.
		await job.promise;
		// Let the deliverResult setTimeout(0) (if any) and microtasks flush.
		await new Promise((r) => setTimeout(r, 20));

		assert.equal(
			job.status,
			"cancelled",
			`status must REMAIN 'cancelled' after the run promise settles, got '${job.status}' ` +
				`(the .then branch clobbered the user-cancelled status)`,
		);
		assert.equal(
			delivered.includes(jobId),
			false,
			"a cancelled job must not fire an onJobComplete follow-up",
		);
	},
);

test("graceful cancel: killProcessTree re-export resolves (load-time check)", async () => {
	// This test is a belt-and-suspenders static check. If killProcessTree were
	// not re-exported, the import at the top of this file would have already
	// caused the entire test file to fail to load. We do an explicit runtime
	// check here to make the intent clear and produce a readable assertion failure
	// rather than a cryptic module-not-found error in the test runner output.
	const mod = await import("@gsd/pi-coding-agent");
	assert.ok(
		typeof (mod as Record<string, unknown>).killProcessTree === "function",
		"killProcessTree must be exported from @gsd/pi-coding-agent",
	);
});

test(
	"timeout path: SIGTERM-immune job is force-killed (SIGKILL), not left running in the background",
	// Worst case ~12s (1s timeout + 5s grace + 3s hard-deadline + 3s poll); the
	// explicit timeout prevents an infinite hang if force-resolve ever regresses.
	{ skip: process.platform === "win32" ? "Unix-primary graceful semantics" : false, timeout: 20_000 },
	async (t) => {
		// Regression: the timeout path previously called a local killTree that only
		// ever sent SIGTERM (twice), so a `trap '' TERM` child survived its timeout
		// and ran forever in the background. It now routes through killProcessTree,
		// which escalates SIGTERM -> grace -> SIGKILL. This proves the child is
		// actually dead shortly after the 5s grace window, not orphaned.
		const dir = mkdtempSync(join(tmpdir(), "async-timeout-sigkill-"));
		const pidFile = join(dir, "pgid.pid");
		t.after(() => {
			// Best-effort: kill the process group if the test failed and left it alive.
			try {
				const pgid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
				// Guard pgid > 0: process.kill(-0, ...) would signal the test runner's OWN
				// process group (-0 === 0 === "caller's group" under POSIX).
				if (Number.isFinite(pgid) && pgid > 0) process.kill(-pgid, "SIGKILL");
			} catch {
				/* already gone */
			}
			rmSync(dir, { recursive: true, force: true });
		});

		const manager = new AsyncJobManager();
		const tool = createAsyncBashTool(() => manager, () => process.cwd());

		// echo $$ records the detached shell's PID (process-group leader). The shell
		// ignores SIGTERM and loops forever, so only SIGKILL can end it.
		const command = `echo $$ > '${pidFile}'; trap '' TERM; while true; do sleep 1; done`;
		const result = await tool.execute(
			"tc-timeout-sigkill",
			{ command, label: "timeout-sigkill", timeout: 1 },
			noopSignal,
			() => {},
			undefined as never,
		);

		const text = result.content.map((c: { type: string; text?: string }) => c.text ?? "").join("\n");
		const jobId = text.match(/\*\*(bg_[a-f0-9]+)\*\*/)?.[1];
		assert.ok(jobId, `Expected a job ID, got: ${text}`);

		// The promise force-resolves at ~timeout + grace + hard-deadline (~1+5+3s).
		await manager.getJob(jobId)!.promise;

		const pgid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
		assert.ok(Number.isFinite(pgid) && pgid > 0, "child must have recorded a valid positive process-group PID");

		// Poll briefly: SIGKILL was sent at timeout+grace (~6s); give it a moment to reap.
		const deadlineMs = Date.now() + 3_000;
		while (isAlive(pgid) && Date.now() < deadlineMs) {
			await new Promise((r) => setTimeout(r, 100));
		}
		assert.equal(
			isAlive(pgid),
			false,
			`SIGTERM-immune timed-out job (pgid ${pgid}) must be SIGKILLed, not left running`,
		);

		manager.shutdown();
	},
);

test("graceful cancel: job promise settles even for node process on cancel", async () => {
	const manager = new AsyncJobManager();
	const tool = createAsyncBashTool(() => manager, () => process.cwd());

	// node process that blocks for 30s — responds to SIGTERM
	const result = await tool.execute(
		"tc-cancel-02",
		{
			command: `node -e "setTimeout(()=>{}, 30000)"`,
			label: "cancel-test-node",
		},
		noopSignal,
		() => {},
		undefined as never,
	);

	const text = result.content.map((c: { type: string; text?: string }) => c.text ?? "").join("\n");
	const jobId = text.match(/\*\*(bg_[a-f0-9]+)\*\*/)?.[1];
	assert.ok(jobId, "Expected a job ID");

	const job = manager.getJob(jobId)!;
	assert.equal(job.status, "running");

	const cancelResult = manager.cancel(jobId);
	assert.equal(cancelResult, "cancelled");

	const start = Date.now();
	await Promise.race([
		job.promise,
		new Promise<never>((_, reject) => {
			const t = setTimeout(() => {
				reject(new Error(`Job promise hung after cancel (${Date.now() - start}ms)`));
			}, 5_000);
			if (typeof t === "object" && "unref" in t) t.unref();
		}),
	]);

	assert.ok(Date.now() - start < 5_000, "Promise should settle quickly after cancel");
	manager.shutdown();
});

test(
	"cancel path: SIGTERM-immune job force-resolves via hard deadline, does not hang",
	// Worst case ~8s (5s grace + 3s hard-deadline after cancel); explicit timeout
	// guards against an infinite hang if the abort-path force-resolve regresses.
	{ skip: process.platform === "win32" ? "Unix-primary graceful semantics" : false, timeout: 20_000 },
	async () => {
		// Regression: onAbort (the /jobs cancel path) used to kill the child but arm no
		// hard deadline, so cancelling a `trap '' TERM` child that never closes left the
		// job promise dangling forever. It now arms the same hard-deadline force-resolve
		// the timeout path uses.
		const manager = new AsyncJobManager();
		const tool = createAsyncBashTool(() => manager, () => process.cwd());

		const result = await tool.execute(
			"tc-cancel-dstate",
			{ command: `trap '' TERM; while true; do sleep 1; done`, label: "cancel-dstate" },
			noopSignal,
			() => {},
			undefined as never,
		);
		const text = result.content.map((c: { type: string; text?: string }) => c.text ?? "").join("\n");
		const jobId = text.match(/\*\*(bg_[a-f0-9]+)\*\*/)?.[1];
		assert.ok(jobId, "Expected a job ID");

		const job = manager.getJob(jobId)!;
		assert.equal(job.status, "running");
		assert.equal(manager.cancel(jobId), "cancelled");

		// The promise must settle via the hard deadline (~8s) rather than hang.
		const start = Date.now();
		await Promise.race([
			job.promise,
			new Promise<never>((_, reject) => {
				const t = setTimeout(() => {
					reject(new Error(`Cancelled D-state job hung (${Date.now() - start}ms) — abort-path force-resolve missing`));
				}, 15_000);
				if (typeof t === "object" && "unref" in t) t.unref();
			}),
		]);
		assert.ok(Date.now() - start < 15_000, "cancelled D-state job must force-resolve, not hang");

		manager.shutdown();
	},
);

test(
	"ESC during await_job ends the wait but leaves the real background process alive",
	// End-to-end proof of the headline claim: a real OS subprocess (not a synthetic
	// in-process job) must survive an aborted await_job. The await tool resolves on
	// abort; we then confirm the child PID is still alive before cleaning it up.
	{ skip: process.platform === "win32" ? "Unix-primary graceful semantics" : false, timeout: 20_000 },
	async (t) => {
		const dir = mkdtempSync(join(tmpdir(), "await-esc-alive-"));
		const pidFile = join(dir, "pgid.pid");
		const manager = new AsyncJobManager();
		t.after(() => {
			try {
				const pgid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
				if (Number.isFinite(pgid) && pgid > 0) process.kill(-pgid, "SIGKILL");
			} catch {
				/* already gone */
			}
			manager.shutdown();
			rmSync(dir, { recursive: true, force: true });
		});

		const asyncBash = createAsyncBashTool(() => manager, () => process.cwd());
		const awaitJob = createAwaitTool(() => manager);

		// Start a real 60s background process that records its process-group PID.
		const started = await asyncBash.execute(
			"tc-await-esc",
			{ command: `echo $$ > '${pidFile}'; sleep 60`, label: "await-esc-sleeper" },
			noopSignal,
			() => {},
			undefined as never,
		);
		const jobId = started.content.map((c: { type: string; text?: string }) => c.text ?? "").join("\n")
			.match(/\*\*(bg_[a-f0-9]+)\*\*/)?.[1];
		assert.ok(jobId, "expected a job id from async_bash");

		// Give the child a moment to write its pidfile.
		await new Promise((r) => setTimeout(r, 200));
		const pgid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
		assert.ok(Number.isFinite(pgid) && pgid > 0, "child must record a valid pgid");
		assert.equal(isAlive(pgid), true, "child should be alive before the await");

		// await_job, then fire ESC (abort) ~100ms in. The wait must end promptly.
		const ac = new AbortController();
		const abortTimer = setTimeout(() => ac.abort(), 100);
		if (typeof abortTimer === "object" && "unref" in abortTimer) (abortTimer as NodeJS.Timeout).unref();

		const waitStart = Date.now();
		const awaitResult = await awaitJob.execute("tc-await-esc-wait", { jobs: [jobId!] }, ac.signal, () => {}, undefined as never);
		const elapsed = Date.now() - waitStart;
		const awaitText = awaitResult.content.map((c: { type: string; text?: string }) => c.text ?? "").join("\n");

		// (a) The wait ended promptly on ESC, not after the 120s default timeout.
		assert.ok(elapsed < 5_000, `await should end promptly on ESC, took ${elapsed}ms`);
		assert.match(awaitText, /interrupted/i, "aborted await should report the interruption");

		// (b) The job and its real OS process are both STILL ALIVE — ESC ends the wait,
		//     it does not kill the job.
		assert.equal(manager.getJob(jobId!)!.status, "running", "job should still be running after ESC");
		assert.equal(isAlive(pgid), true, "the real background process must survive an aborted await_job");
	},
);
