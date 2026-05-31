import test from "node:test";
import assert from "node:assert/strict";
import { chooseVisionAskVariant, VISION_ASK_VARIANTS } from "../vision-ask.ts";

test("vision ask variants stay varied and conversational", () => {
  assert.ok(VISION_ASK_VARIANTS.length >= 6, "keep enough openers to avoid repetition");
  assert.equal(new Set(VISION_ASK_VARIANTS).size, VISION_ASK_VARIANTS.length, "openers should be unique");

  for (const opener of VISION_ASK_VARIANTS) {
    assert.ok(opener.length <= 72, `opener should stay short: ${opener}`);
    assert.doesNotMatch(opener, /\n/, "opener should be a single line");
    assert.doesNotMatch(opener, /\bstakeholders?|key success metrics?|business objectives?\b/i, "avoid corporate wording");
    assert.notEqual(opener, "What's the vision?", "do not keep the old fixed opener in rotation");
  }
});

test("chooseVisionAskVariant picks from the configured opener list", () => {
  assert.equal(chooseVisionAskVariant(() => 0), VISION_ASK_VARIANTS[0]);
  assert.equal(
    chooseVisionAskVariant((exclusiveMax) => exclusiveMax - 1),
    VISION_ASK_VARIANTS[VISION_ASK_VARIANTS.length - 1],
  );
});
