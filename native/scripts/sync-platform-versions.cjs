#!/usr/bin/env node

/**
 * Synchronize platform package versions with the root package version.
 *
 * Reads version from root package.json, writes it to all platform
 * package.json files and updates optionalDependencies in root package.json.
 */

const fs = require("fs");
const path = require("path");
const { resolveEngineOptionalDependencyVersion } = require("../../scripts/lib/version-sync.cjs");

const rootDir = path.resolve(__dirname, "..", "..");
const npmDir = path.resolve(__dirname, "..", "npm");

const rootPkgPath = path.join(rootDir, "package.json");
const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf-8"));
const version = rootPkg.version;
const optionalDependencyVersion = resolveEngineOptionalDependencyVersion(version);

console.log(`[sync-platform-versions] Syncing to version ${version}`);
if (optionalDependencyVersion !== version) {
  console.log(
    `[sync-platform-versions] optionalDependencies pinned to stable engine version ${optionalDependencyVersion}`,
  );
}

const platformPackages = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64-gnu",
  "linux-arm64-gnu",
  "win32-x64-msvc",
];

// Update each platform package.json and keep the root package pinned to the
// same engine version. Native ABI mismatches should fail before publish, not
// install an older platform package at runtime.
for (const platform of platformPackages) {
  const pkgPath = path.join(npmDir, platform, "package.json");
  if (!fs.existsSync(pkgPath)) {
    console.warn(`  Skipping ${platform}: ${pkgPath} not found`);
    continue;
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  if (pkg.version !== version) {
    console.log(`  ${platform}: ${pkg.version} -> ${version}`);
    pkg.version = version;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  } else {
    console.log(`  ${platform}: already ${version}`);
  }

  const dependencyName = `@opengsd/engine-${platform}`;
  if (rootPkg.optionalDependencies?.[dependencyName] !== optionalDependencyVersion) {
    rootPkg.optionalDependencies = rootPkg.optionalDependencies || {};
    rootPkg.optionalDependencies[dependencyName] = optionalDependencyVersion;
    console.log(`  root optionalDependencies.${dependencyName}: ${optionalDependencyVersion}`);
  }
}

fs.writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + "\n");

console.log("[sync-platform-versions] Done.");
