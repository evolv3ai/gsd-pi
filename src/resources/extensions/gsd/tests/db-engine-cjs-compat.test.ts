import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

test("db engine stays free of import.meta syntax for CommonJS chunks", () => {
  const enginePath = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "engine.ts");
  const source = readFileSync(enginePath, "utf-8");

  assert.doesNotMatch(source, /\bimport\.meta\b/);
});
