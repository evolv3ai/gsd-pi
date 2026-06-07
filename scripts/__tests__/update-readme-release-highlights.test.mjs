// Project/App: gsd-pi
// File Purpose: Regression tests for README release highlight generation.

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReadmeReleaseHighlights,
  collectReleaseHighlights,
  updateReadmeReleaseHighlights,
} from "../update-readme-release-highlights.mjs";

test("collectReleaseHighlights prioritizes features before fixes", () => {
  const releaseNotes = [
    "### Fixed",
    "- **gsd**: repair stale milestone summaries",
    "- **install**: keep native package versions aligned",
    "",
    "### Added",
    "- **browser-tools**: use managed gsd-browser engine",
    "- add guided installer recovery",
  ].join("\n");

  assert.deepEqual(collectReleaseHighlights(releaseNotes, 3), [
    "- **browser-tools:** Use managed gsd-browser engine.",
    "- **Added:** Add guided installer recovery.",
    "- **gsd:** Repair stale milestone summaries.",
  ]);
});

test("buildReadmeReleaseHighlights includes a normalized latest release label", () => {
  const section = buildReadmeReleaseHighlights("### Changed\n- **tui**: compact status rail", {
    version: "1.2.3",
  });

  assert.match(section, /<!-- release-highlights:start -->/);
  assert.match(section, /Latest release: \*\*v1\.2\.3\*\*/);
  assert.match(section, /- \*\*tui:\*\* Compact status rail\./);
  assert.match(section, /<!-- release-highlights:end -->/);
});

test("updateReadmeReleaseHighlights replaces only the latest-release section", () => {
  const readme = [
    "# GSD Pi",
    "",
    "## Feature Roll-Up",
    "",
    "Keep this text.",
    "",
    "## Latest Release Highlights",
    "",
    "- Old release bullet",
    "",
    "## Status",
    "",
    "Still here.",
    "",
  ].join("\n");

  const updated = updateReadmeReleaseHighlights(readme, "### Added\n- **gsd**: add release flow", {
    version: "v2.0.0",
  });

  assert.match(updated, /## Feature Roll-Up\n\nKeep this text\./);
  assert.match(updated, /Latest release: \*\*v2\.0\.0\*\*/);
  assert.match(updated, /- \*\*gsd:\*\* Add release flow\./);
  assert.doesNotMatch(updated, /Old release bullet/);
  assert.match(updated, /## Status\n\nStill here\./);
});

test("updateReadmeReleaseHighlights fails if the README section is missing", () => {
  assert.throws(
    () => updateReadmeReleaseHighlights("# GSD Pi\n", "### Added\n- one"),
    /Latest Release Highlights/,
  );
});
