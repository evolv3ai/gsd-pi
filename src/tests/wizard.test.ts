import { test } from "node:test";
import assert from "node:assert/strict";
import { isStoredEnvCredential, loadStoredEnvKeys } from "../wizard.ts";

test("isStoredEnvCredential rejects external CLI sentinel credentials", () => {
	assert.equal(isStoredEnvCredential({ type: "api_key", key: "cli" }), false);
assert.equal(isStoredEnvCredential({ type: "api_key", key: "cursor-token" }), true);
});

test("loadStoredEnvKeys does not hydrate external CLI sentinel credentials into env", () => {
	const original = process.env.CURSOR_API_KEY;
	delete process.env.CURSOR_API_KEY;
	try {
		loadStoredEnvKeys({
			getCredentialsForProvider(provider: string) {
				return provider === "cursor-agent" ? [{ type: "api_key", key: "cli" }] : [];
			},
		} as never);

		assert.equal(process.env.CURSOR_API_KEY, undefined);
	} finally {
		if (original === undefined) delete process.env.CURSOR_API_KEY;
		else process.env.CURSOR_API_KEY = original;
	}
});
