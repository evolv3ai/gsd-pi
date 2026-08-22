import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { checkTmuxKeyboardSetup } from "./interactive-startup.js";

const originalTmux = process.env.TMUX;
const originalPath = process.env.PATH;

afterEach(() => {
	if (originalTmux === undefined) delete process.env.TMUX;
	else process.env.TMUX = originalTmux;

	if (originalPath === undefined) delete process.env.PATH;
	else process.env.PATH = originalPath;
});

test("checkTmuxKeyboardSetup does not warn when the tmux query is inconclusive", async () => {
	process.env.TMUX = "test-session";
	process.env.PATH = "";

	assert.equal(await checkTmuxKeyboardSetup(), undefined);
});
