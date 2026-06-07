#!/usr/bin/env node
// Project/App: gsd-pi
// File Purpose: Refresh README latest-release highlights from generated release notes.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_MAX_HIGHLIGHTS = 8;

const README_HEADING = "## Latest Release Highlights";
const SECTION_START = "<!-- release-highlights:start -->";
const SECTION_END = "<!-- release-highlights:end -->";
const CATEGORY_ORDER = ["Added", "Changed", "Fixed", "Removed"];

export function buildReadmeReleaseHighlights(releaseNotes, options = {}) {
  const highlights = collectReleaseHighlights(
    releaseNotes,
    options.maxHighlights ?? DEFAULT_MAX_HIGHLIGHTS,
  );

  if (highlights.length === 0) {
    throw new Error("Release notes did not contain any markdown bullet highlights.");
  }

  const lines = [SECTION_START];
  const version = formatReleaseVersion(options.version ?? "");

  if (version) {
    lines.push(`Latest release: **${version}**`, "");
  }

  lines.push(...highlights, "", SECTION_END);

  return lines.join("\n");
}

export function updateReadmeReleaseHighlights(readme, releaseNotes, options = {}) {
  const headingMatch = new RegExp(`^${escapeRegExp(README_HEADING)}\\s*$`, "m").exec(readme);

  if (!headingMatch) {
    throw new Error(`${README_HEADING} section not found in README.md.`);
  }

  const sectionStart = headingMatch.index;
  const bodyStart = sectionStart + headingMatch[0].length;
  const nextHeadingOffset = readme.slice(bodyStart).search(/\n##\s+/);
  const sectionEnd =
    nextHeadingOffset === -1 ? readme.length : bodyStart + nextHeadingOffset;

  const sectionBody = buildReadmeReleaseHighlights(releaseNotes, options);
  const replacement = `${README_HEADING}\n\n${sectionBody}\n`;

  return `${readme.slice(0, sectionStart)}${replacement}${readme.slice(sectionEnd)}`;
}

export function collectReleaseHighlights(releaseNotes, maxHighlights = DEFAULT_MAX_HIGHLIGHTS) {
  const max = Number(maxHighlights);

  if (!Number.isInteger(max) || max <= 0) {
    throw new Error("--max must be a positive integer.");
  }

  const items = [];
  let currentCategory = "";

  for (const rawLine of releaseNotes.replace(/\r\n/g, "\n").split("\n")) {
    const heading = /^#{2,6}\s+(.+?)\s*$/.exec(rawLine);
    if (heading) {
      currentCategory = normalizeCategory(heading[1]);
      continue;
    }

    const bullet = /^\s*[-*]\s+(.+?)\s*$/.exec(rawLine);
    if (!bullet || !currentCategory) {
      continue;
    }

    const text = formatHighlight(currentCategory, bullet[1]);
    if (text) {
      items.push({
        category: currentCategory,
        order: items.length,
        text,
      });
    }
  }

  const seen = new Set();
  return items
    .filter((item) => {
      const key = item.text.toLowerCase().replace(/[`*_:\s]+/g, " ").trim();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort((a, b) => {
      const categoryDiff = categoryRank(a.category) - categoryRank(b.category);
      return categoryDiff || a.order - b.order;
    })
    .slice(0, max)
    .map((item) => item.text);
}

function formatHighlight(category, value) {
  const cleaned = stripInlineMarkdown(cleanReleaseNoteText(value));
  if (!cleaned) {
    return "";
  }

  const scoped = /^\*\*([^*]+)\*\*:\s*(.+)$/.exec(value.trim());
  const label = scoped ? stripInlineMarkdown(cleanReleaseNoteText(scoped[1])) : category;
  const description = scoped
    ? stripInlineMarkdown(cleanReleaseNoteText(scoped[2]))
    : cleaned;

  if (!label || !description) {
    return "";
  }

  return `- **${label}:** ${punctuate(capitalizeFirst(description))}`;
}

function cleanReleaseNoteText(value) {
  return value
    .replace(/<!--.*?-->/g, "")
    .replace(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/g, "#$1")
    .replace(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)/g, "#$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function stripInlineMarkdown(value) {
  return value
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .trim();
}

function normalizeCategory(value) {
  const normalized = value.toLowerCase().trim();

  if (/^(added|features?)$/.test(normalized)) return "Added";
  if (/^(changed|improvements?|updates?)$/.test(normalized)) return "Changed";
  if (/^(fixed|fixes|bug fixes?)$/.test(normalized)) return "Fixed";
  if (/^(removed|deprecated)$/.test(normalized)) return "Removed";

  return value.trim();
}

function categoryRank(category) {
  const index = CATEGORY_ORDER.indexOf(category);
  return index === -1 ? CATEGORY_ORDER.length : index;
}

function capitalizeFirst(value) {
  return value.replace(/^[a-z]/, (match) => match.toUpperCase());
}

function punctuate(value) {
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

function formatReleaseVersion(value) {
  const trimmed = String(value).trim();
  if (!trimmed) {
    return "";
  }
  return /^v/i.test(trimmed) ? trimmed : `v${trimmed}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseArgs(argv) {
  const args = {
    maxHighlights: DEFAULT_MAX_HIGHLIGHTS,
    readmePath: "README.md",
    releaseNotesPath: "",
    version: process.env.RELEASE_VERSION || process.env.RELEASE_TAG || "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--readme") {
      args.readmePath = requireValue(argv, (index += 1), arg);
      continue;
    }

    if (arg === "--version") {
      args.version = requireValue(argv, (index += 1), arg);
      continue;
    }

    if (arg === "--max") {
      args.maxHighlights = Number(requireValue(argv, (index += 1), arg));
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (args.releaseNotesPath) {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }

    args.releaseNotesPath = arg;
  }

  if (!args.releaseNotesPath) {
    throw new Error("Missing release notes file path.");
  }

  return args;
}

function requireValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function printUsage() {
  console.log(
    [
      "Usage: node scripts/update-readme-release-highlights.mjs <release-notes.md> [options]",
      "",
      "Options:",
      "  --readme <path>    README path to update (default: README.md)",
      "  --version <value>  Release version/tag shown in the highlights section",
      "  --max <count>      Maximum highlights to include (default: 8)",
    ].join("\n"),
  );
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const readmePath = resolve(args.readmePath);
  const releaseNotesPath = resolve(args.releaseNotesPath);
  const readme = readFileSync(readmePath, "utf8");
  const releaseNotes = readFileSync(releaseNotesPath, "utf8");
  const updated = updateReadmeReleaseHighlights(readme, releaseNotes, args);

  if (updated === readme) {
    console.log("[update-readme-release-highlights] README.md already current.");
    return;
  }

  writeFileSync(readmePath, updated);
  console.log("[update-readme-release-highlights] Updated README.md release highlights.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(`[update-readme-release-highlights] ${error.message}`);
    process.exit(1);
  }
}
