// Project/App: gsd-pi
// File Purpose: Unit turn abort cleanup regression tests.

import assert from "node:assert/strict";
import test from "node:test";

import { abortActiveUnitTurn } from "../auto/unit-turn-abort.ts";

test("abortActiveUnitTurn aborts the provided context", () => {
  let abortCalls = 0;

  const aborted = abortActiveUnitTurn({
    abort: () => {
      abortCalls += 1;
    },
  });

  assert.equal(aborted, true);
  assert.equal(abortCalls, 1);
});

test("abortActiveUnitTurn is best-effort when context lacks abort or abort throws", () => {
  assert.equal(abortActiveUnitTurn({}), false);
  assert.equal(abortActiveUnitTurn(null), false);

  const aborted = abortActiveUnitTurn({
    abort: () => {
      throw new Error("abort failed");
    },
  });

  assert.equal(aborted, false);
});
