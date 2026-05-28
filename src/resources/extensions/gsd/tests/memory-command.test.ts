// gsd-pi — /gsd memory command catalog coverage

import test from "node:test";
import assert from "node:assert/strict";

import { GSD_COMMAND_DESCRIPTION, getGsdArgumentCompletions, TOP_LEVEL_SUBCOMMANDS } from "../commands/catalog.ts";

test("/gsd memory appears in the command description and top-level completions", () => {
  assert.match(GSD_COMMAND_DESCRIPTION, /\|memory\|/);

  const completions = getGsdArgumentCompletions("mem");
  const entry = completions.find((completion) => completion.value === "memory");

  assert.ok(entry, "memory should appear in top-level completions");
  assert.match(entry.description, /memor/i);
});

test("memory is registered in TOP_LEVEL_SUBCOMMANDS", () => {
  const entry = TOP_LEVEL_SUBCOMMANDS.find((command) => command.cmd === "memory");
  assert.ok(entry, "memory must be present in TOP_LEVEL_SUBCOMMANDS");
  assert.match(entry?.desc ?? "", /memor/i);
});
