/**
 * Resolves which plan to sync and which milestone correlates it.
 *
 * Path given: the manifest is the exporter's sibling (<dir>/<stem>.manifest.json
 * — see commands/export.ts siblingPath). No path: scan <cwd>/specs/*.manifest.json
 * (the same directory commands/status.ts findBridgeManifest trusts); exactly one
 * wins, several means the caller must choose — never guess.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, basename, extname, join, isAbsolute, resolve } from "node:path";

export interface SyncTarget { htmlPath: string; manifestPath: string; milestoneId: string }
export type LocateResult = { ok: true; target: SyncTarget } | { ok: false; message: string };

export interface LocateOptions {
  /** Lazy provider of active/last-completed milestone ids — consulted ONLY in
   *  the multi-candidate case to narrow the choice (M4 rider). Failures
   *  degrade to today's "pass a path explicitly" listing. */
  activeIds?: () => Promise<string[]>;
}

/** Shared "run the build first" message family (M4 rider: three commands repeat it). */
export function buildFirst(detail: string): string {
  return `${detail} — run /planf3-gsd-build first`;
}

/** Same sibling naming rule the exporter uses (commands/export.ts siblingPath). */
export function manifestPathFor(htmlPath: string): string {
  return join(dirname(htmlPath), `${basename(htmlPath, extname(htmlPath))}.manifest.json`);
}

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

async function readManifest(path: string): Promise<Record<string, unknown> | null> {
  try {
    return obj(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return null; // missing or unreadable — callers decide what that means
  }
}

function milestoneIdOf(manifest: Record<string, unknown>): string | null {
  const id = obj(manifest.gsd)?.milestoneId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function htmlPathOf(manifest: Record<string, unknown>): string | null {
  const p = obj(manifest.planf3)?.htmlPath;
  return typeof p === "string" && p.length > 0 ? p : null;
}

export async function locateSyncTarget(cwd: string, htmlPathArg: string | null, opts: LocateOptions = {}): Promise<LocateResult> {
  if (htmlPathArg !== null) {
    const htmlPath = isAbsolute(htmlPathArg) ? htmlPathArg : resolve(cwd, htmlPathArg);
    const manifestPath = manifestPathFor(htmlPath);
    const manifest = await readManifest(manifestPath);
    if (manifest === null) {
      // Distinguish missing file from corrupt JSON
      try {
        await stat(manifestPath);
        // File exists but is unparseable
        return { ok: false, message: `manifest ${manifestPath} is unreadable (corrupt JSON?) — re-run /planf3-gsd-build` };
      } catch {
        // Manifest does not exist — distinguish a typo'd HTML path (nothing to
        // build from) from the expected "run the build" case.
        try {
          await stat(htmlPath);
        } catch {
          return { ok: false, message: `plan file not found: ${htmlPath}` };
        }
        return { ok: false, message: buildFirst(`no bridge manifest at ${manifestPath}`) };
      }
    }
    const milestoneId = milestoneIdOf(manifest);
    if (milestoneId === null) {
      return { ok: false, message: buildFirst(`manifest ${manifestPath} has no gsd.milestoneId`) };
    }
    return { ok: true, target: { htmlPath, manifestPath, milestoneId } };
  }

  let names: string[];
  try {
    names = await readdir(join(cwd, "specs"));
  } catch {
    return { ok: false, message: buildFirst("no bridge manifest found (no specs/ directory)") };
  }
  const candidates: { manifestPath: string; htmlPath: string | null; milestoneId: string | null }[] = [];
  for (const name of names.filter((n) => n.endsWith(".manifest.json")).sort()) {
    const manifestPath = join(cwd, "specs", name);
    const manifest = await readManifest(manifestPath);
    if (manifest === null) continue; // unreadable — skip it, like findBridgeManifest
    const rel = htmlPathOf(manifest);
    candidates.push({
      manifestPath,
      htmlPath: rel === null ? null : isAbsolute(rel) ? rel : resolve(cwd, rel),
      milestoneId: milestoneIdOf(manifest),
    });
  }
  if (candidates.length === 0) {
    return { ok: false, message: buildFirst("no bridge manifest in specs/") };
  }
  let pool = candidates;
  if (pool.length > 1 && opts.activeIds !== undefined) {
    try {
      const ids = await opts.activeIds();
      const narrowed = pool.filter((c) => c.milestoneId !== null && ids.includes(c.milestoneId));
      if (narrowed.length > 0) pool = narrowed;
    } catch {
      // provider failure — degrade to the unfiltered listing
    }
  }
  if (pool.length > 1) {
    const list = pool.map((c) => c.htmlPath ?? c.manifestPath).join("\n  ");
    return { ok: false, message: `multiple bridge manifests found — pass a plan path explicitly:\n  ${list}` };
  }
  const only = pool[0];
  if (only.htmlPath === null) {
    return { ok: false, message: `manifest ${only.manifestPath} has no planf3.htmlPath` };
  }
  if (only.milestoneId === null) {
    return { ok: false, message: buildFirst(`manifest ${only.manifestPath} has no gsd.milestoneId`) };
  }
  return { ok: true, target: { htmlPath: only.htmlPath, manifestPath: only.manifestPath, milestoneId: only.milestoneId } };
}
