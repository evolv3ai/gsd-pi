import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = resolve(new URL("../../", import.meta.url).pathname);

async function importValidatePackWithRootPackage(rootPackageJson) {
  const outdir = await mkdtemp(join(tmpdir(), "validate-pack-test-"));
  const outfile = join(outdir, "entry.mjs");
  const logs = [];
  const plugin = {
    name: "validate-pack-stubs",
    setup(buildApi) {
      buildApi.onResolve({ filter: /^node:(child_process|fs|module|os)$/ }, (args) => ({
        path: args.path,
        namespace: "validate-pack-stub",
      }));
      buildApi.onLoad({ filter: /.*/, namespace: "validate-pack-stub" }, (args) => {
        const stubs = {
          "node:child_process": `
            export function execFileSync() {
              throw new Error("npm commands must not run after an early package guard failure");
            }
          `,
          "node:fs": `
            export function copyFileSync() {}
            export function cpSync() {}
            export function existsSync() { return true; }
            export function mkdirSync() {}
            export function mkdtempSync(prefix) { return prefix + "stub"; }
            export function readdirSync() { return []; }
            export function readFileSync(path) {
              if (String(path).endsWith("package.json")) return ${JSON.stringify(JSON.stringify(rootPackageJson))};
              return "";
            }
            export function rmSync() {}
            export function statSync() { return { isDirectory: () => true, size: 1234 }; }
            export function writeFileSync() {}
          `,
          "node:module": `
            export function createRequire() {
              return () => ({ getLinkablePackages: () => [] });
            }
          `,
          "node:os": `
            export function tmpdir() { return "/tmp"; }
          `,
        };
        return { contents: stubs[args.path], loader: "js", resolveDir: root };
      });
    },
  };
  await build({
    entryPoints: [join(root, "scripts/validate-pack.js")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    plugins: [plugin],
  });

  const originalLog = console.log;
  const originalExit = process.exit;
  console.log = (...values) => {
    logs.push(values.map(String).join(" "));
  };
  process.exit = ((code) => {
    const error = new Error(`process.exit(${code})`);
    error.code = code;
    throw error;
  });
  try {
    await import(pathToFileURL(outfile).href);
    assert.fail("validate-pack should have exited");
  } catch (error) {
    assert.equal(error.code, 1);
    return logs;
  } finally {
    console.log = originalLog;
    process.exit = originalExit;
  }
}

test("validate-pack fails before npm pack when publishable dependencies contain workspace ranges", async () => {
  const logs = await importValidatePackWithRootPackage({
    dependencies: {
      "@gsd/pi-ai": "workspace:*",
    },
  });
  const output = logs.join("\n");
  assert.match(output, /Checking for workspace: protocol leaks/);
  assert.match(output, /dependencies\.@gsd\/pi-ai=workspace:\*/);
  assert.match(output, /Remove internal workspace packages/);
  assert.doesNotMatch(output, /Packing tarball/);
});
