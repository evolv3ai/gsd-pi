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

test("abortActiveUnitTurn skips abort when the context reports idle", () => {
  let abortCalls = 0;

  const aborted = abortActiveUnitTurn({
    isIdle: () => true,
    abort: () => {
      abortCalls += 1;
    },
  });

  assert.equal(aborted, false);
  assert.equal(abortCalls, 0);
});

test("abortActiveUnitTurn aborts when the context reports non-idle", () => {
  let abortCalls = 0;

  const aborted = abortActiveUnitTurn({
    isIdle: () => false,
    abort: () => {
      abortCalls += 1;
    },
  });

  assert.equal(aborted, true);
  assert.equal(abortCalls, 1);
});

test("abortActiveUnitTurn falls back to abort when isIdle throws", () => {
  let abortCalls = 0;

  const aborted = abortActiveUnitTurn({
    isIdle: () => {
      throw new Error("isIdle failed");
    },
    abort: () => {
      abortCalls += 1;
    },
  });

  assert.equal(aborted, true);
  assert.equal(abortCalls, 1);
});
