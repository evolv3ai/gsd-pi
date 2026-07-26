// Covers the per-surface nav registry: surface filtering, extras ordering, and
// the href-vs-view selection branch (FLU-5).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  NAV_ITEMS,
  resolveNavItems,
  selectNavItem,
  type NavItem,
} from "../workspace-nav.ts";

const icon = NAV_ITEMS[0].icon;

function item(id: string, surfaces?: NavItem["surfaces"], href?: string): NavItem {
  return { id, label: id, icon, surfaces, href };
}

// Run serially: some tests mutate the shared exported NAV_ITEMS, so concurrent
// subtests (if the runner's concurrency is ever enabled) could race.
describe("resolveNavItems", { concurrency: false }, () => {
  test("built-in views are unchanged in order on both surfaces", () => {
    const expected = ["dashboard", "power", "chat", "roadmap", "files", "activity", "visualize"];
    assert.deepEqual(
      resolveNavItems([], "bundled").map((i) => i.id),
      expected,
    );
    assert.deepEqual(
      resolveNavItems([], "saas").map((i) => i.id),
      expected,
    );
  });

  test("an entry without surfaces renders on both", () => {
    const both = item("both");
    assert.ok(resolveNavItems([both], "bundled").includes(both));
    assert.ok(resolveNavItems([both], "saas").includes(both));
  });

  test("a saas-only entry is filtered out of the bundled surface", () => {
    const extras = [item("machines", ["saas"])];
    assert.deepEqual(
      resolveNavItems(extras, "bundled").map((i) => i.id),
      NAV_ITEMS.map((i) => i.id),
    );
    assert.ok(resolveNavItems(extras, "saas").some((i) => i.id === "machines"));
  });

  test("a bundled-only entry is filtered out of the saas surface", () => {
    const extras = [item("shutdown", ["bundled"])];
    assert.ok(resolveNavItems(extras, "bundled").some((i) => i.id === "shutdown"));
    assert.deepEqual(
      resolveNavItems(extras, "saas").map((i) => i.id),
      NAV_ITEMS.map((i) => i.id),
    );
  });

  test("extras render after the built-in views", () => {
    const resolved = resolveNavItems([item("machines", ["saas"])], "saas");
    assert.equal(resolved.length, NAV_ITEMS.length + 1);
    assert.equal(resolved.at(-1)?.id, "machines");
  });

  test("duplicate ids are collapsed: last value wins, first position kept", () => {
    // A host reusing a built-in id (or duplicating within extras) must not
    // produce duplicate React keys; the later entry overrides in place.
    const override = item("dashboard");
    override.label = "Overridden";
    const resolved = resolveNavItems([override, item("machines"), item("machines")], "bundled");

    const ids = resolved.map((i) => i.id);
    assert.equal(new Set(ids).size, ids.length, "no duplicate ids");
    // "dashboard" keeps its original first position but takes the extra's value.
    assert.equal(ids[0], "dashboard");
    assert.equal(resolved[0].label, "Overridden");
    // The two "machines" extras collapse into one entry.
    assert.equal(ids.filter((id) => id === "machines").length, 1);
  });

  test("filtering a built-in view out of one surface leaves the other intact", () => {
    // The registry ships nothing hidden today; this guards the mechanism itself
    // by temporarily scoping a built-in entry and asserting via resolveNavItems.
    const target = NAV_ITEMS[1];
    const original = target.surfaces;
    target.surfaces = ["bundled"];
    try {
      const saasIds = resolveNavItems([], "saas").map((i) => i.id);
      assert.ok(!saasIds.includes("power"));
      assert.equal(saasIds.length, NAV_ITEMS.length - 1);

      const bundledIds = resolveNavItems([], "bundled").map((i) => i.id);
      assert.ok(bundledIds.includes("power"));
      assert.equal(bundledIds.length, NAV_ITEMS.length);
    } finally {
      target.surfaces = original;
    }
  });
});

// Run serially: these tests mutate the shared globalThis.window.
describe("selectNavItem", { concurrency: false }, () => {
  test("switches the active view when there is no href", () => {
    const seen: string[] = [];
    selectNavItem(item("files"), (view) => seen.push(view));
    assert.deepEqual(seen, ["files"]);
  });

  test("navigates and does not switch view when an href is present", () => {
    const g = globalThis as { window?: unknown };
    const hadWindow = "window" in g;
    const original = g.window;
    const location = { href: "" };
    g.window = { location };
    try {
      const seen: string[] = [];
      selectNavItem(item("machines", ["saas"], "/devices"), (view) => seen.push(view));
      assert.equal(location.href, "/devices");
      assert.deepEqual(seen, []);
    } finally {
      // Restore the exact pre-test state: deleting when window was absent, so we
      // don't leave a `window` property that later `"window" in globalThis` sees.
      if (hadWindow) g.window = original;
      else delete g.window;
    }
  });

  test("throws a clear error for an href entry outside a browser", () => {
    const g = globalThis as { window?: unknown };
    const hadWindow = "window" in g;
    const original = g.window;
    delete g.window;
    try {
      const seen: string[] = [];
      assert.throws(
        () => selectNavItem(item("machines", ["saas"], "/devices"), (view) => seen.push(view)),
        /window is undefined/,
      );
      assert.deepEqual(seen, []);
    } finally {
      if (hadWindow) g.window = original;
      else delete g.window;
    }
  });
});
