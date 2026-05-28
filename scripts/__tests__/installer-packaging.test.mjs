// Project/App: gsd-pi
// File Purpose: Regression tests for installer package dependencies.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const lockfile = JSON.parse(readFileSync("package-lock.json", "utf8"));

test("installer tarball bundles undici at the package root", () => {
  assert.ok(pkg.dependencies.undici, "root package must depend on undici");
  assert.ok(
    pkg.bundledDependencies.includes("undici"),
    "root bundledDependencies must include undici",
  );
  assert.ok(
    lockfile.packages[""].bundleDependencies.includes("undici"),
    "lockfile root bundleDependencies must include undici",
  );
});
