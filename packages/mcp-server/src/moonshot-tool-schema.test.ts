import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { normalizeObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { collectForbiddenUnionSchemaPaths, sanitizeSchemaForMoonshot } from "@gsd/pi-ai";
import { SessionManager } from "./session-manager.js";
import { createMcpServer } from "./server.js";

test("sanitizeSchemaForMoonshot flattens zod union workflow fields", () => {
	const schema = z.object({
		milestoneId: z.string(),
		keyFiles: z.union([z.array(z.string()), z.string()]).optional(),
		mode: z.union([z.literal("build"), z.literal("query")]),
	});

	const raw = toJsonSchemaCompat(schema, { strictUnions: true, pipeStrategy: "input" });
	assert.ok(JSON.stringify(raw).includes("anyOf"), "zod unions should produce anyOf before sanitization");

	const sanitized = sanitizeSchemaForMoonshot(raw);
	assert.equal(sanitized.type, "object");
	assert.deepEqual(collectForbiddenUnionSchemaPaths(sanitized), []);
	const modeSchema = (sanitized.properties as Record<string, unknown>).mode;
	assert.ok(modeSchema && typeof modeSchema === "object");
	assert.equal("anyOf" in modeSchema, false);
});

test("createMcpServer advertises Moonshot-safe inputSchema for every tool", async () => {
	const sm = new SessionManager();
	const { server } = await createMcpServer(sm);

	const registeredTools =
		(server as { _registeredTools?: Record<string, { enabled: boolean; inputSchema?: unknown }> })._registeredTools ??
		{};
	let toolCount = 0;

	for (const [name, tool] of Object.entries(registeredTools)) {
		if (!tool.enabled) continue;
		toolCount += 1;

		const obj = normalizeObjectSchema(tool.inputSchema as Parameters<typeof normalizeObjectSchema>[0]);
		const raw = obj
			? toJsonSchemaCompat(obj, { strictUnions: true, pipeStrategy: "input" })
			: { type: "object", properties: {} };
		const sanitized = sanitizeSchemaForMoonshot(raw);

		assert.equal(sanitized.type, "object", `${name}: root type must be object`);
		assert.deepEqual(
			collectForbiddenUnionSchemaPaths(sanitized),
			[],
			`${name}: Moonshot schema must not contain anyOf/oneOf/allOf`,
		);
	}

	assert.ok(toolCount >= 50, `expected broad MCP tool surface, got ${toolCount}`);
});
