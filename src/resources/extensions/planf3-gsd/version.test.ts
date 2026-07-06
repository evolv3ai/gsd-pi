import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GENERATOR_VERSION } from "./version.js";

describe("GENERATOR_VERSION", () => {
  test("matches package.json version", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(await readFile(join(here, "package.json"), "utf8"));
    assert.equal(GENERATOR_VERSION, pkg.version);
  });

  test("matches extension-manifest.json version", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(await readFile(join(here, "extension-manifest.json"), "utf8"));
    assert.equal(GENERATOR_VERSION, manifest.version);
  });
});
