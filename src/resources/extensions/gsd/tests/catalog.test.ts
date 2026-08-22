import assert from "node:assert/strict";
import { test } from "node:test";

import { getGsdArgumentCompletions } from "../commands/catalog.ts";

test("quick command completion surfaces every right-sizing flag", () => {
  const labels = getGsdArgumentCompletions("quick ").map((completion) => completion.label);

  assert.deepEqual(labels, ["--discuss", "--research", "--validate", "--full"]);
});
