import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyUatContent,
  classifyUatContentForRun,
  getDeclaredUatType,
  getUatBrowserToolSupportError,
  isPartialEligibleUatType,
  resolveEffectiveUatType,
  shouldDispatchUatForContent,
  shouldEscalateArtifactUatToBrowser,
  uatTypeIncludesBrowser,
  validateUatModePolicy,
} from "../uat-policy.ts";
import {
  assertBrowserAutomationContractAvailable,
  assertBrowserAutomationContractMissing,
  assertBrowserBackedUatCanDispatch,
  BROWSER_AUTOMATION_CONTRACT_TOOLS,
} from "./browser-automation-contract-fixture.ts";

describe("uat-policy", () => {
  it("defaults missing UAT mode to artifact-driven", () => {
    assert.equal(getDeclaredUatType("# UAT\n\nCheck generated files."), "artifact-driven");
  });

  it("parses a bare keyword under ## UAT Type (M006/S01 agent format drift)", () => {
    const content = [
      "# S01 UAT",
      "",
      "## UAT Type",
      "browser-executable",
      "",
      "## Preconditions",
      "- Run `node tests/browser/search-uat.mjs` (it starts its own server on an ephemeral port; do not start serve-static separately).",
    ].join("\n");
    assert.equal(getDeclaredUatType(content), "browser-executable");
    assert.equal(shouldEscalateArtifactUatToBrowser(content), false);
  });

  it("promotes browser-executable UAT when slice context names test:uat but UAT only documents test:server (M007/S01)", () => {
    const uatFile = [
      "# S01 UAT",
      "",
      "## UAT Type",
      "- UAT mode: browser-executable",
      "",
      "## Preconditions",
      "- Start the dev/local verification server with `npm run test:server`.",
      "- Open the app at the localhost URL printed by the server.",
    ].join("\n");
    const sliceContext = [
      "Fresh slice-level verification ran via `gsd_exec` with `npm run test:uat` and passed.",
      "The run produced PASS with browser diagnostics consoleErrors=0.",
    ].join("\n");

    assert.equal(classifyUatContentForRun(uatFile, sliceContext).effectiveType, "runtime-executable");
    assert.equal(classifyUatContentForRun(uatFile).effectiveType, "browser-executable");
  });

  it("promotes browser-executable UAT to runtime-executable when a self-contained harness is named (M006/S01)", () => {
    const content = [
      "# S01 UAT",
      "",
      "## UAT Type",
      "- UAT mode: browser-executable",
      "",
      "## Preconditions",
      "- Start the local app server with `npm run start`.",
      "- Open the app at `http://127.0.0.1:4173`.",
      "",
      "## Evidence",
      "- Fresh closeout verification command: `node --check app.js && node --check tests/browser/search-uat.mjs && npm run test:uat`",
    ].join("\n");

    assert.equal(resolveEffectiveUatType(content), "runtime-executable");
    assert.deepEqual(classifyUatContent(content), {
      declaredType: "browser-executable",
      modeDeclared: true,
      effectiveType: "runtime-executable",
      browserRequired: false,
      shouldDispatchByDefault: true,
    });
  });

  it("parses a UAT mode line case-insensitively with bold markers", () => {
    const content = [
      "## UAT Type",
      "- **UAT Mode:** Runtime-Executable (npx playwright test)",
    ].join("\n");
    assert.equal(getDeclaredUatType(content), "runtime-executable");
  });

  it("does not parse prose in the section as a mode declaration", () => {
    const content = [
      "## UAT Type",
      "- Why this mode is sufficient: static checks cover the schema.",
    ].join("\n");
    assert.equal(getDeclaredUatType(content), "artifact-driven");
  });

  it("treats an explicit UAT mode line with an unrecognised value as undeclared", () => {
    const content = [
      "## UAT Type",
      "- UAT mode: manual-spot-check",
      "- browser-executable would also work",
    ].join("\n");
    // The explicit declaration wins (and fails to parse) — the stray keyword
    // bullet below it must not be promoted to the declared mode.
    assert.equal(getDeclaredUatType(content), "artifact-driven");
  });

  it("escalates artifact-driven UAT to browser-executable when the spec requires browser work", () => {
    const content = [
      "## UAT Type",
      "- UAT mode: artifact-driven",
      "",
      "## Test",
      "Open the page in a browser and verify the submit button is visible.",
    ].join("\n");

    assert.equal(shouldEscalateArtifactUatToBrowser(content), true);
    assert.equal(resolveEffectiveUatType(content), "browser-executable");
    assert.equal(shouldDispatchUatForContent(content, undefined), true);
    assert.deepEqual(classifyUatContent(content), {
      declaredType: "artifact-driven",
      modeDeclared: true,
      effectiveType: "browser-executable",
      browserRequired: true,
      shouldDispatchByDefault: true,
    });
  });

  it("does not escalate disclaimer-only browser mentions", () => {
    const content = [
      "## UAT Type",
      "- UAT mode: artifact-driven",
      "",
      "## Not Proven By This UAT",
      "- No live browser session was run in this artifact check.",
    ].join("\n");

    assert.equal(shouldEscalateArtifactUatToBrowser(content), false);
    assert.equal(resolveEffectiveUatType(content), "artifact-driven");
    assert.equal(shouldDispatchUatForContent(content, undefined), false);
  });

  it("centralizes which UAT modes receive browser tools", () => {
    for (const uatType of ["browser-executable", "live-runtime", "mixed", "human-experience"] as const) {
      assert.equal(uatTypeIncludesBrowser(uatType), true, `${uatType} should include browser tools`);
    }

    for (const uatType of ["artifact-driven", "runtime-executable"] as const) {
      assert.equal(uatTypeIncludesBrowser(uatType), false, `${uatType} should not include browser tools`);
    }
  });

  it("detects Browser Automation Contract capability across adapters", () => {
    assertBrowserAutomationContractAvailable(BROWSER_AUTOMATION_CONTRACT_TOOLS.piProvider);
    assertBrowserAutomationContractAvailable(BROWSER_AUTOMATION_CONTRACT_TOOLS.externalMcpClient);
    assertBrowserAutomationContractAvailable(BROWSER_AUTOMATION_CONTRACT_TOOLS.externalMcpWildcard);
    assertBrowserAutomationContractAvailable(BROWSER_AUTOMATION_CONTRACT_TOOLS.otherBrowserMcp);
    assertBrowserAutomationContractMissing(BROWSER_AUTOMATION_CONTRACT_TOOLS.workflowOnly);
    assertBrowserAutomationContractMissing(BROWSER_AUTOMATION_CONTRACT_TOOLS.withoutBrowser);
    assertBrowserAutomationContractMissing(undefined);
  });

  it("reports missing browser tools only for browser-backed UAT with a known tool snapshot", () => {
    assert.equal(
      getUatBrowserToolSupportError({
        uatType: "artifact-driven",
        activeTools: ["read", "gsd_uat_exec"],
        milestoneId: "M001",
        sliceId: "S01",
      }),
      null,
    );
    assert.equal(
      getUatBrowserToolSupportError({
        uatType: "browser-executable",
        activeTools: undefined,
        milestoneId: "M001",
        sliceId: "S01",
      }),
      null,
    );
    assertBrowserBackedUatCanDispatch({
      uatType: "human-experience",
      activeTools: BROWSER_AUTOMATION_CONTRACT_TOOLS.withoutBrowser,
      registeredTools: BROWSER_AUTOMATION_CONTRACT_TOOLS.piProvider,
    });
    assertBrowserBackedUatCanDispatch({
      uatType: "human-experience",
      activeTools: BROWSER_AUTOMATION_CONTRACT_TOOLS.withoutBrowser,
      registeredTools: BROWSER_AUTOMATION_CONTRACT_TOOLS.externalMcpWildcard,
    });

    const error = getUatBrowserToolSupportError({
      uatType: "browser-executable",
      activeTools: ["read", "gsd_uat_exec"],
      milestoneId: "M001",
      sliceId: "S01",
    });
    assert.match(error ?? "", /Cannot dispatch browser-backed run-uat for M001\/S01/);
  });

  it("centralizes partial verdict eligibility", () => {
    assert.equal(isPartialEligibleUatType("mixed"), true);
    assert.equal(isPartialEligibleUatType("human-experience"), true);
    assert.equal(isPartialEligibleUatType("live-runtime"), true);
    assert.equal(isPartialEligibleUatType("artifact-driven"), false);
    assert.equal(isPartialEligibleUatType("browser-executable"), false);
    assert.equal(isPartialEligibleUatType("runtime-executable"), false);
  });

  it("requires runtime evidence for runtime-executable UAT", () => {
    assert.equal(
      validateUatModePolicy({
        uatType: "runtime-executable",
        verdict: "PASS",
        checks: [{ mode: "artifact", result: "PASS" }],
      }),
      "runtime-executable UAT requires runtime evidence",
    );

    assert.equal(
      validateUatModePolicy({
        uatType: "runtime-executable",
        verdict: "PASS",
        checks: [{ mode: "runtime", result: "PASS" }],
      }),
      null,
    );
  });

  it("requires browser evidence for browser-executable UAT", () => {
    assert.equal(
      validateUatModePolicy({
        uatType: "browser-executable",
        verdict: "PASS",
        checks: [{ mode: "runtime", result: "PASS" }],
      }),
      "browser-executable UAT requires browser evidence",
    );

    assert.equal(
      validateUatModePolicy({
        uatType: "browser-executable",
        verdict: "PASS",
        checks: [{ mode: "browser", result: "PASS" }],
      }),
      null,
    );
  });

  it("allows live-runtime evidence through either runtime or browser checks", () => {
    assert.equal(
      validateUatModePolicy({
        uatType: "live-runtime",
        verdict: "PASS",
        checks: [{ mode: "artifact", result: "PASS" }],
      }),
      "live-runtime UAT requires runtime or browser evidence",
    );

    assert.equal(
      validateUatModePolicy({
        uatType: "live-runtime",
        verdict: "PASS",
        checks: [{ mode: "browser", result: "PASS" }],
      }),
      null,
    );
  });
});
