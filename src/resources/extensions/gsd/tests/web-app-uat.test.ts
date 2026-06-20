import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildWebAppUatGuidanceBlock,
  detectWebApp,
  findPlaywrightTestScript,
  hasPlaywrightTestDependency,
} from "../web-app-uat.ts";

function scaffoldProject(root: string, pkg: Record<string, unknown>): void {
  writeFileSync(join(root, "package.json"), JSON.stringify(pkg, null, 2));
}

const LEGACY_ENGINE = { engine: "legacy", source: "probe", reason: "test" } as const;
const MANAGED_ENGINE = { engine: "gsd-browser", source: "probe", reason: "test" } as const;
const OFF_ENGINE = { engine: "off", source: "env", reason: "test" } as const;

describe("web-app-uat guidance", () => {
  test("returns null for non-web projects", () => {
    const root = mkdtempSync(join(tmpdir(), "gsd-web-uat-"));
    try {
      writeFileSync(join(root, "README.md"), "# CLI tool\n");
      assert.equal(detectWebApp(root), false);
      assert.equal(buildWebAppUatGuidanceBlock(root), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns guidance for react/vite web apps", () => {
    const root = mkdtempSync(join(tmpdir(), "gsd-web-uat-"));
    try {
      scaffoldProject(root, {
        dependencies: { react: "19.0.0", "react-dom": "19.0.0" },
        devDependencies: { vite: "6.0.0" },
        scripts: { dev: "vite" },
      });
      assert.equal(detectWebApp(root), true);
      const block = buildWebAppUatGuidanceBlock(root, LEGACY_ENGINE);
      assert.ok(block);
      assert.match(block!, /browser-executable/);
      assert.match(block!, /Playwright-backed `browser_\*` tools/);
      assert.match(block!, /Playwright scaffolding/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("describes the managed gsd-browser engine when it is the resolved backing", () => {
    const root = mkdtempSync(join(tmpdir(), "gsd-web-uat-"));
    try {
      scaffoldProject(root, {
        dependencies: { react: "19.0.0" },
        scripts: { dev: "vite" },
      });
      const block = buildWebAppUatGuidanceBlock(root, MANAGED_ENGINE);
      assert.ok(block);
      assert.match(block!, /managed gsd-browser engine/);
      assert.match(block!, /browser-executable/);
      assert.doesNotMatch(block!, /Playwright-backed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("steers to runtime-executable UAT when browser tools are off", () => {
    const root = mkdtempSync(join(tmpdir(), "gsd-web-uat-"));
    try {
      scaffoldProject(root, {
        dependencies: { react: "19.0.0" },
        scripts: { dev: "vite" },
      });
      const block = buildWebAppUatGuidanceBlock(root, OFF_ENGINE);
      assert.ok(block);
      assert.match(block!, /browser tools are disabled/);
      assert.doesNotMatch(block!, /- `browser-executable`/);
      // mixed/live-runtime require browser tools per UAT_MODE_POLICIES, so the
      // bullet must drop out too — recommending them would dead-end at dispatch.
      assert.doesNotMatch(block!, /- `mixed`/);
      assert.doesNotMatch(block!, /interactive `browser_\*` checks/);
      assert.match(block!, /runtime-executable/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("detects existing Playwright and npm script", () => {
    const root = mkdtempSync(join(tmpdir(), "gsd-web-uat-"));
    try {
      scaffoldProject(root, {
        dependencies: { next: "15.0.0" },
        devDependencies: { "@playwright/test": "1.60.0", playwright: "1.60.0" },
        scripts: { "test:e2e": "playwright test" },
      });
      assert.equal(hasPlaywrightTestDependency(root), true);
      assert.equal(findPlaywrightTestScript(root), "npm run test:e2e");
      const block = buildWebAppUatGuidanceBlock(root);
      assert.ok(block);
      assert.match(block!, /dependency detected/);
      assert.match(block!, /npm run test:e2e/);
      assert.doesNotMatch(block!, /Playwright scaffolding/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not mistake a non-playwright e2e script as playwright", () => {
    const root = mkdtempSync(join(tmpdir(), "gsd-web-uat-"));
    try {
      scaffoldProject(root, {
        dependencies: { react: "19.0.0" },
        devDependencies: { "@playwright/test": "1.60.0" },
        scripts: { e2e: "cypress run", dev: "vite" },
      });
      // The e2e script runs Cypress, not Playwright — must not be returned
      assert.equal(findPlaywrightTestScript(root), null);
      const block = buildWebAppUatGuidanceBlock(root);
      assert.ok(block);
      // Playwright dep is present so guidance shows "dependency detected", not "scaffolding"
      assert.match(block!, /dependency detected/);
      assert.doesNotMatch(block!, /Playwright scaffolding/);
      // Falls back to generic npx command because no playwright-named script exists
      assert.doesNotMatch(block!, /npm run e2e/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recognises playwright via script value even without a local dependency", () => {
    const root = mkdtempSync(join(tmpdir(), "gsd-web-uat-"));
    try {
      scaffoldProject(root, {
        dependencies: { next: "15.0.0" },
        scripts: { "test:e2e": "npx playwright test" },
      });
      assert.equal(hasPlaywrightTestDependency(root), false);
      assert.equal(findPlaywrightTestScript(root), "npm run test:e2e");
      const block = buildWebAppUatGuidanceBlock(root);
      assert.ok(block);
      // Script-based detection should trigger "dependency detected" path, not scaffolding
      assert.match(block!, /dependency detected/);
      assert.match(block!, /npm run test:e2e/);
      assert.doesNotMatch(block!, /Playwright scaffolding/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not treat playwright install script as a test command", () => {
    const root = mkdtempSync(join(tmpdir(), "gsd-web-uat-"));
    try {
      scaffoldProject(root, {
        dependencies: { react: "19.0.0" },
        devDependencies: { "@playwright/test": "1.60.0" },
        // postinstall runs 'playwright install' (browser setup), not a test
        scripts: { postinstall: "playwright install", "test:e2e": "npx playwright test" },
      });
      // install script must not be returned; the real test script should be
      assert.equal(findPlaywrightTestScript(root), "npm run test:e2e");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns null when only an install script mentions playwright", () => {
    const root = mkdtempSync(join(tmpdir(), "gsd-web-uat-"));
    try {
      scaffoldProject(root, {
        dependencies: { react: "19.0.0" },
        devDependencies: { "@playwright/test": "1.60.0" },
        scripts: { postinstall: "playwright install --with-deps" },
      });
      assert.equal(findPlaywrightTestScript(root), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("detects static sites via index.html", () => {
    const root = mkdtempSync(join(tmpdir(), "gsd-web-uat-"));
    try {
      mkdirSync(join(root, "public"), { recursive: true });
      writeFileSync(join(root, "public", "index.html"), "<html></html>");
      assert.equal(detectWebApp(root), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
