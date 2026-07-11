/**
 * Surgical, string-level rewriting of a Planf3 HTML plan (FR-8 preservation
 * contract): never re-serializes the DOM. Only two kinds of spans change —
 * the token inside the Nth <code class="status"> occurrence, and rows inside
 * the header metadata <dl>. Every other byte survives verbatim.
 *
 * Safety: the occurrence count is re-derived here from the raw text and must
 * equal what the parse predicted; any count or token disagreement aborts with
 * no output ("plan changed under us; re-run").
 */
import type { MarkerUpdate } from "./marker-map.js";
import { RANK } from "./marker-map.js";
import { STATUS_FROM_MARKER } from "../parser/types.js";

export interface MetadataPatch {
  gsdMilestone: string;
  /** null = unknown this run; an existing row is left untouched. */
  gsdSession: string | null;
  /** ISO stamp appended to the modified list — only when the rewrite changes anything. */
  syncStamp: string;
}

export interface AppliedChange { occurrence: number; from: string; to: string; label: string }

export type RewriteResult =
  | { ok: true; changed: boolean; html: string; applied: AppliedChange[]; metaChanges: string[] }
  | { ok: false; reason: string };

// Narrow on purpose: tolerate quoting/whitespace variance on the opening tag,
// nothing else — the wider the match, the wider the blast radius of a splice.
const MARKER_RE = /(<code\s+class\s*=\s*(?:"status"|'status')\s*>)(\s*)(\[[a-z]*\])(\s*)(<\/code>)/g;

interface Occurrence { tokenStart: number; tokenEnd: number; token: string }

function scanMarkers(html: string): Occurrence[] {
  const out: Occurrence[] = [];
  for (const m of html.matchAll(MARKER_RE)) {
    const at = m.index ?? 0;
    const tokenStart = at + m[1].length + m[2].length;
    out.push({ tokenStart, tokenEnd: tokenStart + m[3].length, token: m[3] });
  }
  return out;
}

type MetaOutcome =
  | { ok: true; html: string; rowsChanged: boolean; metaChanges: string[] }
  | { ok: false; reason: string };

function patchMetadata(html: string, meta: MetadataPatch, markersChanged: boolean): MetaOutcome {
  const detailsAt = html.search(/<details\s+class\s*=\s*(?:"meta"|'meta')/);
  if (detailsAt === -1) return { ok: false, reason: 'metadata block (<details class="meta">) not found' };
  const detailsClose = html.indexOf("</details>", detailsAt);
  const dlOpen = html.indexOf("<dl", detailsAt);
  const dlClose = html.indexOf("</dl>", dlOpen);
  if (dlOpen === -1 || dlClose === -1 || (detailsClose !== -1 && dlOpen > detailsClose)) {
    return { ok: false, reason: "metadata <dl> not found" };
  }

  let region = html.slice(dlOpen, dlClose); // all edits stay inside the metadata dl
  const metaChanges: string[] = [];

  const upsert = (name: string, value: string): void => {
    const rowRe = new RegExp(`(<dt>\\s*${name}\\s*</dt>\\s*<dd>)([^<]*)(</dd>)`, "i");
    const m = rowRe.exec(region);
    if (m) {
      if (m[2].trim() === value) return; // already correct
      region = region.slice(0, m.index) + m[1] + value + m[3] + region.slice(m.index + m[0].length);
    } else {
      // Append a new row after the last one, matching existing row indentation;
      // the trailing "\n<indent>" before </dl> is preserved.
      const rowIndent = /\n([ \t]*)<dt/.exec(region)?.[1] ?? "  ";
      const tail = /\n[ \t]*$/.exec(region);
      const insertAt = tail ? tail.index : region.length;
      region = region.slice(0, insertAt) + `\n${rowIndent}<dt>${name}</dt><dd>${value}</dd>` + region.slice(insertAt);
    }
    metaChanges.push(`${name} = ${value}`);
  };

  upsert("gsd milestone", meta.gsdMilestone);
  if (meta.gsdSession !== null) upsert("gsd session", meta.gsdSession);

  const rowsChanged = metaChanges.length > 0;
  if (markersChanged || rowsChanged) {
    const modRe = /(<dt>\s*modified\s*<\/dt>\s*<dd>)([^<]*)(<\/dd>)/i;
    const m = modRe.exec(region);
    if (m) {
      const existing = m[2].trim();
      const next = existing === "" || existing === "—" ? meta.syncStamp : `${existing}, ${meta.syncStamp}`;
      region = region.slice(0, m.index) + m[1] + next + m[3] + region.slice(m.index + m[0].length);
      metaChanges.push(`modified += ${meta.syncStamp}`);
    }
    // A template plan always carries a modified row; if absent we still sync markers.
  }

  return { ok: true, html: html.slice(0, dlOpen) + region + html.slice(dlClose), rowsChanged, metaChanges };
}

export function rewriteHtml(
  html: string,
  updates: MarkerUpdate[],
  expectedMarkerCount: number,
  meta: MetadataPatch,
): RewriteResult {
  const occurrences = scanMarkers(html);
  if (occurrences.length !== expectedMarkerCount) {
    return {
      ok: false,
      reason: `marker count mismatch: parse expects ${expectedMarkerCount}, raw document has ${occurrences.length} — plan changed under us; re-run`,
    };
  }

  const applied: AppliedChange[] = [];
  const splices: { start: number; end: number; text: string }[] = [];
  for (const u of updates) {
    const occ = occurrences[u.occurrence];
    if (occ === undefined) return { ok: false, reason: `marker occurrence ${u.occurrence} out of range` };
    if (u.from !== null) {
      if (occ.token !== u.from) {
        return { ok: false, reason: `marker ${u.occurrence} ("${u.label}") reads ${occ.token}, expected ${u.from} — plan changed under us; re-run` };
      }
    } else {
      // Validation markers: the parser exposes no status for them, so the
      // monotonic rule is enforced against the on-disk token here.
      const current = STATUS_FROM_MARKER[occ.token];
      const target = STATUS_FROM_MARKER[u.to];
      if (current === undefined || target === undefined) {
        return { ok: false, reason: `marker ${u.occurrence} ("${u.label}") has unrecognized token ${occ.token}` };
      }
      if (RANK[target] <= RANK[current]) continue; // already at/above target — skip silently
    }
    splices.push({ start: occ.tokenStart, end: occ.tokenEnd, text: u.to });
    applied.push({ occurrence: u.occurrence, from: occ.token, to: u.to, label: u.label });
  }

  // Splice last-to-first so earlier offsets stay valid.
  let out = html;
  for (const s of [...splices].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, s.start) + s.text + out.slice(s.end);
  }

  const metaOut = patchMetadata(out, meta, applied.length > 0);
  if (!metaOut.ok) return metaOut;

  const changed = applied.length > 0 || metaOut.rowsChanged;
  return { ok: true, changed, html: changed ? metaOut.html : html, applied, metaChanges: metaOut.metaChanges };
}
