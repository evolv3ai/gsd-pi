import { isNativeAddonLoaded, native } from "../native.js";

export function syncDirectoryEntry(path: string): void {
  const sync = native.syncDirectoryEntry;
  // When the addon fails to load, `native` is a throw-on-call proxy whose
  // every property reads back as a function, so the typeof guard alone would
  // pass and the call would fail with the proxy's generic message wrapped as
  // "failed" instead of the intended "unavailable". Check the load state
  // first; the typeof guard still covers a real-but-stale addon.
  if (!isNativeAddonLoaded() || typeof sync !== "function") throw new Error("native directory durability is unavailable");
  try {
    sync(path);
  } catch (error) {
    throw new Error("native directory durability failed", { cause: error });
  }
}
