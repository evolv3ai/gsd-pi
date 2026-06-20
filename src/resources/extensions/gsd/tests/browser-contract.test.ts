import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  BROWSER_CONTRACT_TOOL_NAMES,
  BROWSER_EVIDENCE_SIGNAL_TOOL_NAMES,
  hasBrowserContractPrefix,
  isBrowserContractToolName,
} from "../../shared/browser-contract.ts";
import { isUatBrowserToolName } from "../uat-policy.ts";
import { BROWSER_REQUIREMENT_RE, BROWSER_RUNTIME_RE } from "../browser-evidence.ts";

// Note: RUN_UAT_BROWSER_TOOL_NAMES and MANAGED_GSD_BROWSER_TOOL_NAMES are
// reference-equal aliases of BROWSER_CONTRACT_TOOL_NAMES, and the managed
// adapter's spec table is Record-keyed by BrowserContractToolName — both
// derivations are pinned by the type system, not by runtime assertions here.
describe("Browser Automation Contract parity", () => {
  it("every contract name satisfies the UAT browser-tool predicate, bare and MCP-prefixed", () => {
    for (const name of BROWSER_CONTRACT_TOOL_NAMES) {
      assert.equal(isUatBrowserToolName(name), true, name);
      assert.equal(isUatBrowserToolName(`mcp__gsd-browser__${name}`), true, `mcp__gsd-browser__${name}`);
    }
  });

  it("contract names are canonical browser_* names with no duplicates", () => {
    assert.equal(new Set(BROWSER_CONTRACT_TOOL_NAMES).size, BROWSER_CONTRACT_TOOL_NAMES.length);
    for (const name of BROWSER_CONTRACT_TOOL_NAMES) {
      assert.equal(hasBrowserContractPrefix(name), true, name);
      assert.equal(isBrowserContractToolName(name), true, name);
    }
    assert.equal(isBrowserContractToolName("browser_not_a_real_tool"), false);
    assert.equal(hasBrowserContractPrefix("gsd_uat_exec"), false);
  });

  it("evidence-signal names stay a subset of the contract and drive the detection regexes", () => {
    for (const name of BROWSER_EVIDENCE_SIGNAL_TOOL_NAMES) {
      assert.equal(isBrowserContractToolName(name), true, name);
      // Identifier-shaped names keep the regex splice in browser-evidence.ts escape-free.
      assert.match(name, /^browser_[a-z_]+$/);
      assert.match(`Verified via ${name} call`, BROWSER_REQUIREMENT_RE);
      assert.match(`Verified via ${name} call`, BROWSER_RUNTIME_RE);
    }
  });
});
