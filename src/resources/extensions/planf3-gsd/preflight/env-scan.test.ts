import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanEnvVars, guessEnvNames, envFileSet } from "./env-scan.js";

describe("scanEnvVars", () => {
  test("env-file beats process.env, records which file; values never surface", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-envscan-"));
    await writeFile(join(tmp, ".env"), "USE_FIXTURES=1\nDATABASE_URL=postgres://real:secret@host/db\n");
    await writeFile(join(tmp, ".env.local"), "CLERK_SECRET_KEY=sk_test_XYZ\n");
    const findings = await scanEnvVars(
      ["USE_FIXTURES", "CLERK_SECRET_KEY", "OPENROUTER_API_KEY", "SHELL_ONLY_VAR"],
      { root: tmp, env: { SHELL_ONLY_VAR: "fromshell", OPENROUTER_API_KEY: undefined } },
    );
    assert.deepEqual(findings, [
      { name: "USE_FIXTURES", provenance: "env-file", file: ".env" },
      { name: "CLERK_SECRET_KEY", provenance: "env-file", file: ".env.local" },
      { name: "OPENROUTER_API_KEY", provenance: "not-found", file: null },
      { name: "SHELL_ONLY_VAR", provenance: "process-env", file: null },
    ]);
    assert.ok(!JSON.stringify(findings).includes("secret"), "values must never surface");
  });

  test("mode file participates in the set", async () => {
    assert.deepEqual(envFileSet("production"), [".env", ".env.local", ".env.production"]);
    assert.deepEqual(envFileSet(), [".env", ".env.local"]);
  });
});

describe("guessEnvNames", () => {
  test("extracts credential-shaped UPPER_SNAKE names, deduped", () => {
    const text = "Use OPENROUTER_API_KEY server-side; DATABASE_URL comes from Neon. OPENROUTER_API_KEY again. NOT_a_var, HTTP.";
    assert.deepEqual(guessEnvNames(text), ["OPENROUTER_API_KEY", "DATABASE_URL"]);
  });
});
