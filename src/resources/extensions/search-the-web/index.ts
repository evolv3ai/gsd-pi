/**
 * Web Search Extension v4
 *
 * Native Anthropic hooks stay eager. Heavy tool registration is deferred in
 * interactive mode so startup is not blocked on the full search tool stack.
 *
 * Provider gating: the Brave/Tavily/Ollama-backed tools (search-the-web,
 * search_and_read) are only registered when a provider API key is actually
 * configured (resolveSearchProvider() !== null). Without a key these tools can
 * only return an auth error, so presenting them to the model is pure confusion
 * — the agent reaches for a tool that cannot work. fetch_page is always
 * registered because it works key-free via Jina Reader.
 */

import { importExtensionModule, type ExtensionAPI } from "@gsd/pi-coding-agent";
import { registerSearchProviderCommand } from "./command-search-provider.js";
import { registerNativeSearchHooks } from "./native-search.js";
import { resolveSearchProvider } from "./provider.js";

// fetch_page registration — always available (key-free via Jina Reader).
let fetchToolPromise: Promise<void> | null = null;
// search-the-web + search_and_read registration — gated on provider key.
let searchToolsPromise: Promise<void> | null = null;
let resetSearchLoopGuardStateRef: (() => void) | null = null;

async function registerFetchTool(pi: ExtensionAPI): Promise<void> {
  if (!fetchToolPromise) {
    fetchToolPromise = (async () => {
      const { registerFetchPageTool } = await importExtensionModule<typeof import("./tool-fetch-page.js")>(
        import.meta.url,
        "./tool-fetch-page.js",
      );
      registerFetchPageTool(pi);
    })().catch((error) => {
      fetchToolPromise = null;
      throw error;
    });
  }

  return fetchToolPromise;
}

/**
 * Register the provider-backed search tools, but only when a search provider
 * key is configured. Memoized so it registers at most once per process; the
 * guard is re-evaluated on each session_start so a key added before a later
 * session is picked up without a restart.
 */
async function registerProviderSearchTools(pi: ExtensionAPI): Promise<void> {
  if (resolveSearchProvider() === null) return;
  if (!searchToolsPromise) {
    searchToolsPromise = (async () => {
      const [
        { registerSearchTool, resetSearchLoopGuardState },
        { registerLLMContextTool },
      ] = await Promise.all([
        importExtensionModule<typeof import("./tool-search.js")>(import.meta.url, "./tool-search.js"),
        importExtensionModule<typeof import("./tool-llm-context.js")>(import.meta.url, "./tool-llm-context.js"),
      ]);
      resetSearchLoopGuardStateRef = resetSearchLoopGuardState;
      registerSearchTool(pi);
      registerLLMContextTool(pi);
    })().catch((error) => {
      searchToolsPromise = null;
      throw error;
    });
  }

  return searchToolsPromise;
}

async function registerSearchTools(pi: ExtensionAPI): Promise<void> {
  await Promise.all([registerFetchTool(pi), registerProviderSearchTools(pi)]);
}

export default function (pi: ExtensionAPI) {
  registerSearchProviderCommand(pi);
  registerNativeSearchHooks(pi);

  pi.on("session_start", async (_event, ctx) => {
    const resetLoopGuardState = () => {
      resetSearchLoopGuardStateRef?.();
    };

    if (ctx.hasUI) {
      resetLoopGuardState();
      void registerSearchTools(pi)
        .then(() => {
          resetLoopGuardState();
        })
        .catch((error) => {
          ctx.ui.notify(`search-the-web failed to load: ${error instanceof Error ? error.message : String(error)}`, "warning");
        });
      return;
    }

    await registerSearchTools(pi);
    resetLoopGuardState();
  });
}
