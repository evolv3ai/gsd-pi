import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePlanf3Html } from "../parser/planf3-html-parser.js";
import { computeSync } from "./marker-map.js";
import { rewriteHtml, type MetadataPatch } from "./html-rewrite.js";

const here = dirname(fileURLToPath(import.meta.url));

const META: MetadataPatch = { gsdMilestone: "M042", gsdSession: null, syncStamp: "2026-07-11T09:00:00Z" };

// Small handwritten doc: 3 markers, metadata dl already carrying the milestone
// row (so marker-only tests do not trip metadata churn), plus a decoy dl in
// #model-policy that must never be touched.
const DOC = `<html><body>
<header><details class="meta"><dl>
  <dt>created</dt><dd>2026-01-01</dd>
  <dt>modified</dt><dd>2026-01-01</dd>
  <dt>gsd milestone</dt><dd>M042</dd>
</dl></details></header>
<section id="phases">
<h3><code class="status">[wip]</code> Phase 1: Setup</h3>
<li><code class="status">[x]</code> done item</li>
<li><code class='status'>[]</code> quoted variant</li>
</section>
<section id="model-policy"><dl><dt>planning</dt><dd>m</dd></dl></section>
</body></html>`;

describe("rewriteHtml — marker splices", () => {
  test("replaces exactly the Nth token; everything else byte-identical", () => {
    const r = rewriteHtml(DOC, [{ occurrence: 0, from: "[wip]", to: "[x]", label: "Phase 1: Setup" }], 3, META);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.changed, true);
    assert.deepEqual(r.applied, [{ occurrence: 0, from: "[wip]", to: "[x]", label: "Phase 1: Setup" }]);
    const expected = DOC
      .replace('<code class="status">[wip]</code>', '<code class="status">[x]</code>')
      .replace("<dd>2026-01-01</dd>\n  <dt>gsd milestone</dt>", "<dd>2026-01-01, 2026-07-11T09:00:00Z</dd>\n  <dt>gsd milestone</dt>");
    assert.equal(r.html, expected);
  });

  test("single-quoted class attribute is still found (occurrence 2)", () => {
    const r = rewriteHtml(DOC, [{ occurrence: 2, from: "[]", to: "[wip]", label: "quoted variant" }], 3, META);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.ok(r.html.includes("<code class='status'>[wip]</code>"));
  });

  test("occurrence count mismatch aborts with no output", () => {
    const r = rewriteHtml(DOC, [], 5, META);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /marker count mismatch/);
  });

  test("current-token mismatch aborts (plan changed under us)", () => {
    const r = rewriteHtml(DOC, [{ occurrence: 0, from: "[]", to: "[x]", label: "Phase 1: Setup" }], 3, META);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /plan changed under us/);
  });

  test("from:null enforces monotonicity against the on-disk token", () => {
    // occurrence 1 is already [x]: raising to [x] is a silent skip, not a change
    const skip = rewriteHtml(DOC, [{ occurrence: 1, from: null, to: "[x]", label: "done item" }], 3, META);
    assert.equal(skip.ok, true);
    if (!skip.ok) return;
    assert.equal(skip.changed, false);
    assert.equal(skip.html, DOC);
    // occurrence 2 is []: raising to [x] applies
    const apply = rewriteHtml(DOC, [{ occurrence: 2, from: null, to: "[x]", label: "quoted variant" }], 3, META);
    assert.equal(apply.ok, true);
    if (!apply.ok) return;
    assert.equal(apply.changed, true);
    assert.equal(apply.applied.length, 1);
  });

  test("from:null on an unknown token aborts", () => {
    const doc = DOC.replace('<code class="status">[x]</code>', '<code class="status">[zz]</code>');
    const r = rewriteHtml(doc, [{ occurrence: 1, from: null, to: "[x]", label: "done item" }], 3, META);
    assert.equal(r.ok, false);
  });
});

describe("rewriteHtml — metadata dl", () => {
  test("no updates and metadata already correct -> changed:false, byte-identical", () => {
    const r = rewriteHtml(DOC, [], 3, META);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.changed, false);
    assert.equal(r.html, DOC);
    assert.deepEqual(r.metaChanges, []);
  });

  test("gsd milestone dd updated in place when value differs", () => {
    const r = rewriteHtml(DOC, [], 3, { ...META, gsdMilestone: "M043" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.changed, true);
    assert.ok(r.html.includes("<dt>gsd milestone</dt><dd>M043</dd>"));
    assert.ok(r.metaChanges.some((c) => c.includes("M043")));
    // modified list stamped because the file changed
    assert.ok(r.html.includes("<dd>2026-01-01, 2026-07-11T09:00:00Z</dd>"));
  });

  test("gsd session row inserted before </dl> when absent and sessionId known", () => {
    const r = rewriteHtml(DOC, [], 3, { ...META, gsdSession: "sess-9" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.ok(r.html.includes("<dt>gsd milestone</dt><dd>M042</dd>\n  <dt>gsd session</dt><dd>sess-9</dd>\n</dl>"));
    // decoy dl untouched
    assert.ok(r.html.includes('<section id="model-policy"><dl><dt>planning</dt><dd>m</dd></dl></section>'));
  });

  test("null session leaves an existing session row untouched", () => {
    const doc = DOC.replace("</dl>", "  <dt>gsd session</dt><dd>old-sess</dd>\n</dl>");
    const r = rewriteHtml(doc, [], 4 - 1, META); // still 3 markers
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.ok(r.html.includes("<dd>old-sess</dd>"));
  });

  test("em-dash modified placeholder is replaced, not appended to", () => {
    const doc = DOC.replace("<dt>modified</dt><dd>2026-01-01</dd>", "<dt>modified</dt><dd>—</dd>");
    const r = rewriteHtml(doc, [{ occurrence: 0, from: "[wip]", to: "[x]", label: "p" }], 3, META);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.ok(r.html.includes("<dt>modified</dt><dd>2026-07-11T09:00:00Z</dd>"));
  });

  test("missing metadata block aborts", () => {
    const doc = DOC.replace('<details class="meta">', "<details>");
    const r = rewriteHtml(doc, [], 3, META);
    assert.equal(r.ok, false);
  });
});

describe("rewriteHtml — fixture round-trip with computeSync", () => {
  test("completion sweep: all markers [x], metadata upserted, everything else intact", () => {
    const original = readFileSync(join(here, "..", "fixtures", "minimal-plan.html"), "utf8");
    const plan = parsePlanf3Html(original);
    const computed = computeSync(
      plan,
      {
        phase: "idle", activeMilestone: null, lastCompletedMilestone: { id: "M042", title: "Minimal Plan" },
        activeSlice: null, activeTask: null, progress: null, cost: 0, nextAction: null, blockers: [], sessionId: "sess-9",
      },
      "M042",
      { slicePhaseIndex: null, taskTarget: null, unmatched: [] },
    );
    const r = rewriteHtml(original, computed.updates, computed.expectedMarkerCount, { ...META, gsdSession: "sess-9" });
    assert.equal(r.ok, true);
    if (!r.ok) return;

    // Build the expected document by hand: every status token -> [x] …
    let expected = original.replace(/(<code class="status">)\[[a-z]*\](<\/code>)/g, "$1[x]$2");
    // … modified list gains the stamp …
    expected = expected.replace(
      "<dt>modified</dt><dd>2026-06-22T10:00:00-05:00</dd>",
      "<dt>modified</dt><dd>2026-06-22T10:00:00-05:00, 2026-07-11T09:00:00Z</dd>",
    );
    // … and the two bridge rows are appended after the last existing row.
    expected = expected.replace(
      "<dt>forward refs</dt><dd>—</dd>",
      "<dt>forward refs</dt><dd>—</dd>\n          <dt>gsd milestone</dt><dd>M042</dd>\n          <dt>gsd session</dt><dd>sess-9</dd>",
    );
    assert.equal(r.html, expected);
    assert.equal(r.applied.length, 8); // occ 1 was already [x]
  });
});
