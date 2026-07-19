import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseResumeArgs, severityForControl, registerControlCommands } from "./control-register.js";

describe("parseResumeArgs", () => {
  test("first non-flag token is the path; none -> null", () => {
    assert.equal(parseResumeArgs(""), null);
    assert.equal(parseResumeArgs("  specs/p.html "), "specs/p.html");
  });
});

describe("severityForControl", () => {
  test("ok -> info; usage/not-located -> error", () => {
    assert.equal(severityForControl("ok"), "info");
    assert.equal(severityForControl("usage"), "error");
    assert.equal(severityForControl("not-located"), "error");
  });
});

describe("registerControlCommands", () => {
  test("registers exactly the four M4 commands", () => {
    const names: string[] = [];
    const pi = { registerCommand: (name: string) => { names.push(name); } };
    registerControlCommands(pi as never);
    assert.deepEqual(names.sort(), ["planf3-gsd-pause", "planf3-gsd-resume", "planf3-gsd-steer", "planf3-gsd-stop"]);
  });
});
