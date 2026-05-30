/**
 * Command feedback — guidance when /gsd commands cannot show interactive menus.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  notifyDiscussNeedsInteractiveMenu,
  notifyInitNeedsInteractiveMenu,
  notifyQueueHubNeedsInteractiveMenu,
  notifySmartEntryNeedsInteractiveMenu,
  requiresInteractiveMenu,
} from "../command-feedback.js";
import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";

function makeCtx(overrides: {
  hasUI?: boolean;
  custom?: boolean;
  select?: boolean;
  uiMode?: string;
}): ExtensionCommandContext {
  const notifications: Array<{ message: string; type: string }> = [];
  return {
    hasUI: overrides.hasUI ?? true,
    ui: {
      notify: (message: string, type: string) => {
        notifications.push({ message, type });
      },
      custom: overrides.custom === false ? undefined : async () => "ok",
      select: overrides.select === false ? undefined : async () => "ok",
      ...(overrides.uiMode ? { mode: overrides.uiMode } : {}),
    },
    _notifications: notifications,
  } as unknown as ExtensionCommandContext & { _notifications: typeof notifications };
}

describe("requiresInteractiveMenu", () => {
  it("returns false when user supplied a direct target", () => {
    const ctx = makeCtx({ hasUI: false });
    assert.equal(requiresInteractiveMenu(ctx, true), false);
  });

  it("returns true when no target and session is not interactive", () => {
    const ctx = makeCtx({ hasUI: false });
    assert.equal(requiresInteractiveMenu(ctx, false), true);
  });

  it("returns false when interactive UI is available", () => {
    const ctx = makeCtx({ hasUI: true });
    assert.equal(requiresInteractiveMenu(ctx, false), false);
  });

  it("returns true in rpc mode even when hasUI is true", () => {
    const ctx = makeCtx({ hasUI: true, uiMode: "rpc" });
    assert.equal(requiresInteractiveMenu(ctx, false), true);
  });
});

describe("notifyDiscussNeedsInteractiveMenu", () => {
  it("suggests direct milestone and slice targets", () => {
    const ctx = makeCtx({ hasUI: false });
    notifyDiscussNeedsInteractiveMenu(ctx, "no menu");
    const notes = (ctx as typeof ctx & { _notifications: Array<{ message: string }> })._notifications;
    assert.equal(notes.length, 1);
    assert.match(notes[0]!.message, /\/gsd discuss M001/);
    assert.match(notes[0]!.message, /\/gsd discuss M001\/S01/);
    assert.match(notes[0]!.message, /no menu/);
  });
});

describe("notifySmartEntryNeedsInteractiveMenu", () => {
  it("suggests headless-friendly alternatives", () => {
    const ctx = makeCtx({ hasUI: false });
    notifySmartEntryNeedsInteractiveMenu(ctx, "no wizard");
    const notes = (ctx as typeof ctx & { _notifications: Array<{ message: string }> })._notifications;
    assert.match(notes[0]!.message, /\/gsd status/);
    assert.match(notes[0]!.message, /\/gsd auto/);
    assert.match(notes[0]!.message, /\/gsd discuss M001/);
  });
});

describe("notifyQueueHubNeedsInteractiveMenu", () => {
  it("mentions reorder and add-work fallback", () => {
    const ctx = makeCtx({ hasUI: false });
    notifyQueueHubNeedsInteractiveMenu(ctx, "headless");
    const notes = (ctx as typeof ctx & { _notifications: Array<{ message: string }> })._notifications;
    assert.match(notes[0]!.message, /\/gsd queue/);
    assert.match(notes[0]!.message, /reorder/i);
  });
});

describe("notifyInitNeedsInteractiveMenu", () => {
  it("directs user to the TUI init wizard", () => {
    const ctx = makeCtx({ hasUI: false });
    notifyInitNeedsInteractiveMenu(ctx, "headless");
    const notes = (ctx as typeof ctx & { _notifications: Array<{ message: string }> })._notifications;
    assert.match(notes[0]!.message, /\/gsd init/);
    assert.match(notes[0]!.message, /TUI/);
  });
});
