import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("gsd-mcp help prints execution-focused usage", () => {
  const result = execFileSync(
    process.execPath,
    [join(__dirname, "mcp-cli.js"), "--help"],
    { encoding: "utf-8", timeout: 5000 },
  );
  assert.ok(result.includes("Usage: gsd-mcp"));
  assert.ok(result.includes("pair --gateway"));
  assert.ok(result.includes("connect"));
});
