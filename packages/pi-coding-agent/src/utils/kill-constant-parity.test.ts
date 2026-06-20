/**
 * Cross-layer parity lock for the graceful-kill timing constant.
 *
 * SIGKILL_GRACE_MS is deliberately duplicated rather than imported in the
 * lowest layer (`@gsd/pi-agent-core` harness/env/nodejs.ts), because
 * pi-agent-core must not depend on pi-coding-agent. Duplication invites drift:
 * someone tunes the canonical 5_000 in shell.ts and the agent-core mirror
 * silently keeps the old value, so the two kill paths escalate to SIGKILL at
 * different times.
 *
 * This test imports BOTH real values (no source grep, no string scanning) and
 * asserts they are equal, so any future divergence fails CI here with a clear
 * message instead of shipping an inconsistent kill ladder.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { SIGKILL_GRACE_MS as CANONICAL_GRACE_MS } from "./shell.js";
import { NODE_ENV_SIGKILL_GRACE_MS } from "@gsd/pi-agent-core";

test("graceful-kill grace period is identical across the canonical and agent-core kill paths", () => {
	assert.equal(
		NODE_ENV_SIGKILL_GRACE_MS,
		CANONICAL_GRACE_MS,
		`pi-agent-core nodejs.ts SIGKILL_GRACE_MS (${NODE_ENV_SIGKILL_GRACE_MS}) drifted from ` +
			`the canonical pi-coding-agent shell.ts value (${CANONICAL_GRACE_MS}). ` +
			`Update the mirror in packages/pi-agent-core/src/harness/env/nodejs.ts to match.`,
	);
});

test("canonical grace period is a sane positive duration", () => {
	assert.ok(
		Number.isInteger(CANONICAL_GRACE_MS) && CANONICAL_GRACE_MS > 0,
		`SIGKILL_GRACE_MS must be a positive integer ms value, got ${CANONICAL_GRACE_MS}`,
	);
});
