import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseRequestArgs } from "./plan-register.js";

const RUN_FLAGS = ["--questionable", "--step", "--no-prefs", "--force", "--step-unsafe"];

describe("parseRequestArgs", () => {
  test("flags after the request", () => {
    const parsed = parseRequestArgs('"add dark mode" --questionable --force', RUN_FLAGS);
    assert.equal(parsed.request, '"add dark mode"');
    assert.deepEqual([...parsed.flags].sort(), ["--force", "--questionable"]);
  });

  test("flags before the request", () => {
    const parsed = parseRequestArgs("--step add dark mode", RUN_FLAGS);
    assert.equal(parsed.request, "add dark mode");
    assert.ok(parsed.flags.has("--step"));
  });

  test("flag in the middle leaves a single joining space", () => {
    const parsed = parseRequestArgs("fix login --force now", RUN_FLAGS);
    assert.equal(parsed.request, "fix login now");
    assert.ok(parsed.flags.has("--force"));
  });

  test("--step-unsafe does not also set --step", () => {
    const parsed = parseRequestArgs("fix it --step-unsafe", RUN_FLAGS);
    assert.ok(parsed.flags.has("--step-unsafe"));
    assert.ok(!parsed.flags.has("--step"));
    assert.equal(parsed.request, "fix it");
  });

  test("internal spacing of the request is preserved", () => {
    const parsed = parseRequestArgs("fix  the   bug --force", RUN_FLAGS);
    assert.equal(parsed.request, "fix  the   bug");
  });

  test("unrecognized --flags stay in the request", () => {
    const parsed = parseRequestArgs("support a --dry-run flag", RUN_FLAGS);
    assert.equal(parsed.request, "support a --dry-run flag");
    assert.equal(parsed.flags.size, 0);
  });

  test("empty and flags-only input → empty request", () => {
    assert.equal(parseRequestArgs("", RUN_FLAGS).request, "");
    assert.equal(parseRequestArgs("  --force  ", RUN_FLAGS).request, "");
  });
});
