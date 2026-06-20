/**
 * Registration gating for the web-search extension.
 *
 * The Brave/Tavily/Ollama-backed tools (search-the-web, search_and_read) must
 * only be registered when a provider API key is configured. Without a key they
 * can only return an auth error, so presenting them to the model causes the
 * agent to reach for a tool that cannot work. fetch_page is always registered
 * because it works key-free via Jina Reader.
 *
 * These tests share one imported module instance (per-file process isolation),
 * so they rely on module-level memoization: the no-provider case runs first and
 * must leave the search-tools promise unset so the with-provider case can still
 * register them.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import searchExtension from "../resources/extensions/search-the-web/index.ts";

interface MockPI {
  registered: Set<string>;
  fireSessionStart(hasUI: boolean): Promise<void>;
}

function createMockPI(): MockPI {
  const registered = new Set<string>();
  const handlers: Array<{ event: string; handler: (...args: any[]) => any }> = [];
  let active: string[] = [];

  const ctx = {
    hasUI: false,
    ui: { notify() {} },
  };

  const pi: any = {
    registered,
    on(event: string, handler: (...args: any[]) => any) {
      handlers.push({ event, handler });
    },
    registerCommand() {},
    registerTool(tool: any) {
      if (typeof tool?.name === "string") {
        registered.add(tool.name);
        active.push(tool.name);
      }
    },
    getActiveTools() {
      return [...active];
    },
    setActiveTools(tools: string[]) {
      active = tools;
    },
    writeTempFile: async () => "/tmp/search-out.txt",
    async fireSessionStart(hasUI: boolean) {
      for (const h of handlers) {
        if (h.event === "session_start") {
          await h.handler({ type: "session_start" }, { ...ctx, hasUI });
        }
      }
    },
  };

  return pi as MockPI;
}

// Isolate provider resolution from the developer's real ~/.gsd config.
const ORIGINAL = {
  GSD_HOME: process.env.GSD_HOME,
  BRAVE_API_KEY: process.env.BRAVE_API_KEY,
  TAVILY_API_KEY: process.env.TAVILY_API_KEY,
  OLLAMA_API_KEY: process.env.OLLAMA_API_KEY,
};

let tmpHome: string;

function clearSearchKeys() {
  delete process.env.BRAVE_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.OLLAMA_API_KEY;
}

test.before(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "gsd-search-gating-"));
  process.env.GSD_HOME = tmpHome;
});

test.after(() => {
  for (const [key, value] of Object.entries(ORIGINAL)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
});

test("no provider key: search-the-web and search_and_read are NOT registered, fetch_page is", async () => {
  clearSearchKeys();

  const pi = createMockPI();
  searchExtension(pi as any);
  await pi.fireSessionStart(false);

  assert.ok(pi.registered.has("fetch_page"), "fetch_page should always register (key-free via Jina)");
  assert.ok(
    !pi.registered.has("search-the-web"),
    "search-the-web must NOT register without a provider key",
  );
  assert.ok(
    !pi.registered.has("search_and_read"),
    "search_and_read must NOT register without a provider key",
  );
});

test("provider key present: search-the-web and search_and_read register", async (t) => {
  clearSearchKeys();
  process.env.BRAVE_API_KEY = "test-brave-key";
  t.after(() => clearSearchKeys());

  const pi = createMockPI();
  searchExtension(pi as any);
  await pi.fireSessionStart(false);

  assert.ok(
    pi.registered.has("search-the-web"),
    "search-the-web should register when a provider key is configured",
  );
  assert.ok(
    pi.registered.has("search_and_read"),
    "search_and_read should register when a provider key is configured",
  );
});
