import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { friendlyError } from "./error-message.js";

describe("friendlyError", () => {
  test("maps ENOENT on html file to plan-file-not-found message", () => {
    const err = Object.assign(new Error("ENOENT"), {
      code: "ENOENT",
      syscall: "open",
      path: "/some/plan.html",
    });
    const msg = friendlyError(err);
    assert.match(msg, /Plan file not found/);
    assert.match(msg, /\/some\/plan\.html/);
  });

  test("maps spawn ENOENT to gsd-binary-not-found message", () => {
    const err = Object.assign(new Error("ENOENT"), {
      code: "ENOENT",
      syscall: "spawn",
      path: "gsd",
    });
    const msg = friendlyError(err);
    assert.match(msg, /gsd binary not found/);
    assert.match(msg, /PATH/);
  });

  test("returns error message for a generic Error", () => {
    const err = new Error("something went wrong");
    const msg = friendlyError(err);
    assert.equal(msg, "something went wrong");
  });
});
