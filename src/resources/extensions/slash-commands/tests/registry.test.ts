import { describe, test } from "node:test";
import assert from "node:assert/strict";
import clearCommand from "../clear.ts";

describe("slash-commands clear", () => {
  test("registers /clear alias that starts a new session", async () => {
    const registered: Array<{ name: string; handler: (args: string, ctx: { newSession: () => Promise<void> }) => Promise<void> }> = [];
    const pi = {
      registerCommand(name: string, spec: { description: string; handler: typeof registered[0]["handler"] }) {
        registered.push({ name, handler: spec.handler });
      },
    };

    clearCommand(pi as never);
    assert.equal(registered.length, 1);
    assert.equal(registered[0].name, "clear");

    let called = false;
    await registered[0].handler("", {
      newSession: async () => {
        called = true;
      },
    });
    assert.equal(called, true);
  });
});
