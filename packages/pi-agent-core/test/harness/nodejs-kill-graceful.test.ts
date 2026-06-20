import { afterEach, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { createTempDir } from "./session-test-utils.ts";

// Collect abort controllers so afterEach can abort any lingering commands.
const liveControllers: AbortController[] = [];

afterEach(async () => {
	for (const ctrl of liveControllers.splice(0)) {
		ctrl.abort();
	}
});

// Spawns POSIX `sleep`/`bash` and asserts SIGTERM-then-SIGKILL escalation, which
// is Unix-primary; skip on Windows where those commands don't exist and the kill
// path is taskkill-based.
describe.skipIf(process.platform === "win32")("NodeExecutionEnv killProcessTree graceful escalation", () => {
	it("terminates a well-behaved child via SIGTERM when aborted (abort path)", async () => {
		// A process that does NOT ignore SIGTERM — 'sleep 60' exits promptly when the group receives SIGTERM.
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const controller = new AbortController();
		liveControllers.push(controller);

		const started = Date.now();
		const execPromise = env.exec("sleep 60", { abortSignal: controller.signal });

		// Abort shortly after spawning so the child is running.
		await new Promise<void>((res) => setTimeout(res, 100));
		controller.abort();

		const result = await execPromise;
		const elapsedMs = Date.now() - started;

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("aborted");
		}
		// Must settle well within the SIGKILL grace window (5 s) — SIGTERM alone should suffice.
		expect(elapsedMs).toBeLessThan(4_000);
	});

	it("escalates to SIGKILL for a SIGTERM-immune child (timeout path) and does not hang", async () => {
		// This child ignores SIGTERM, so the test validates that SIGKILL eventually fires.
		// We use a short timeout so the grace window fires quickly via the exec timeout path.
		// The exec timeout kills the process; we then assert it settles within a generous band.
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const controller = new AbortController();
		liveControllers.push(controller);

		const TIMEOUT_S = 0.2; // exec timeout (seconds) — triggers killProcessTree
		// Wall-clock guard: if escalation doesn't fire, we'd hang. 8 s is generous.
		const WALL_CLOCK_LIMIT_MS = 8_000;

		const execPromise = env.exec("bash -c \"trap '' TERM; sleep 60\"", {
			timeout: TIMEOUT_S,
			abortSignal: controller.signal,
		});

		const guardPromise = new Promise<"timeout-guard">((res) =>
			setTimeout(() => res("timeout-guard"), WALL_CLOCK_LIMIT_MS),
		);

		const winner = await Promise.race([execPromise.then(() => "exec" as const), guardPromise]);

		// The wall-clock guard must NOT win — exec must settle (SIGKILL should fire after grace).
		expect(winner).toBe("exec");

		const result = await execPromise;
		// exec settles with timeout error (the exec-level timeout triggered killProcessTree).
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("timeout");
		}
	});
});
