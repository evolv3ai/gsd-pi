/**
 * Recursively strip verbose metadata from a JSON Schema to reduce payload size.
 *
 * The model already receives tool-level descriptions via the `description`
 * field on the tool definition itself. Parameter-level `description`,
 * `examples`, and `default` values are redundant and waste ~45-60KB per
 * request (128 tools × ~400B avg).
 *
 * This is a pure data transformation — the JSON Schema remains valid
 * (description/examples/default are all optional per JSON Schema spec).
 */
export function sanitizeToolSchema(schema: unknown): unknown {
	if (schema === null || typeof schema !== "object") return schema;
	if (Array.isArray(schema)) return schema.map(sanitizeToolSchema);

	const cleaned: Record<string, unknown> = { ...schema };

	// Remove verbose metadata (model already has tool-level description)
	delete cleaned.description;
	delete cleaned.examples;
	delete cleaned.default;

	// Recurse into nested schema objects
	if (cleaned.properties && typeof cleaned.properties === "object") {
		cleaned.properties = Object.fromEntries(
			Object.entries(cleaned.properties as Record<string, unknown>).map(([k, v]) => [k, sanitizeToolSchema(v)]),
		);
	}
	if (cleaned.items && typeof cleaned.items === "object") {
		cleaned.items = sanitizeToolSchema(cleaned.items);
	}
	if (Array.isArray(cleaned.allOf)) {
		cleaned.allOf = cleaned.allOf.map(sanitizeToolSchema);
	}
	if (Array.isArray(cleaned.anyOf)) {
		cleaned.anyOf = cleaned.anyOf.map(sanitizeToolSchema);
	}
	if (Array.isArray(cleaned.oneOf)) {
		cleaned.oneOf = cleaned.oneOf.map(sanitizeToolSchema);
	}

	return cleaned;
}
