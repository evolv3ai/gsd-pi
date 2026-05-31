/**
 * Skill catalog installation — skills.sh CLI integration and init wizard step.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { showNextAction } from "../shared/tui.js";
import type { ProjectSignals } from "./detection.js";
import { gsdHome } from "./gsd-home.js";
import {
  SKILL_CATALOG,
  type SkillPack,
  matchPacksForProject,
} from "./skill-catalog.data.js";

/**
 * Install a skill pack via the skills.sh CLI.
 * Runs: npx skills add <repo> --skill <name> ... -y
 *
 * Returns true if installation succeeded.
 */
export function installSkillPack(pack: SkillPack): Promise<boolean> {
  return new Promise((resolve) => {
    const args = ["--yes", "skills", "add", pack.repo];

    for (const skill of pack.skills) {
      args.push("--skill", skill);
    }
    args.push("-y");

    execFile("npx", args, { timeout: 120_000 }, (error) => {
      resolve(!error);
    });
  });
}

/**
 * Install multiple packs, batching by repo to minimize npx invocations.
 * Returns the labels of successfully installed packs.
 */
export async function installPacksBatched(
  packs: SkillPack[],
  onProgress?: (label: string) => void,
): Promise<string[]> {
  const byRepo = new Map<string, { skills: string[]; labels: string[] }>();
  for (const pack of packs) {
    const entry = byRepo.get(pack.repo) ?? { skills: [], labels: [] };
    entry.skills.push(...pack.skills);
    entry.labels.push(pack.label);
    byRepo.set(pack.repo, entry);
  }

  const installed: string[] = [];
  for (const [repo, { skills, labels }] of byRepo) {
    onProgress?.(labels.join(", "));
    const ok = await new Promise<boolean>((resolve) => {
      const args = ["--yes", "skills", "add", repo];
      for (const skill of skills) {
        args.push("--skill", skill);
      }
      args.push("-y");
      execFile("npx", args, { timeout: 120_000 }, (error) => {
        resolve(!error);
      });
    });
    if (ok) installed.push(...labels);
  }
  return installed;
}

/**
 * Check if any skills from a pack are already installed.
 * Searches GSD bundled, skills.sh ecosystem, and Claude Code's official directory.
 */
export function isPackInstalled(pack: SkillPack): boolean {
  const skillsDirs = [
    join(gsdHome(), "agent", "skills"),
    join(homedir(), ".agents", "skills"),
    join(homedir(), ".claude", "skills"),
  ];

  return pack.skills.every((name) =>
    skillsDirs.some((dir) => existsSync(join(dir, name, "SKILL.md"))),
  );
}

/**
 * Run skill installation step during project init.
 */
export async function runSkillInstallStep(
  ctx: ExtensionCommandContext,
  signals: ProjectSignals,
): Promise<string[]> {
  const installed: string[] = [];
  const isBrownfield = signals.detectedFiles.length > 0;

  if (isBrownfield) {
    const matched = matchPacksForProject(signals);
    if (matched.length === 0) return installed;

    const toInstall = matched.filter((p) => !isPackInstalled(p));
    if (toInstall.length === 0) return installed;

    const swiftPacks = toInstall.filter((p) => p.matchLanguages?.includes("swift"));
    const iosPacks = toInstall.filter((p) => p.matchXcodePlatforms?.includes("iphoneos"));
    const otherPacks = toInstall.filter((p) => !swiftPacks.includes(p) && !iosPacks.includes(p));

    const summaryLines: string[] = [];
    const hasIOS = signals.xcodePlatforms.includes("iphoneos");
    if (hasIOS) {
      summaryLines.push(`Detected: iOS project (${signals.primaryLanguage ?? "swift"})`);
    } else if (signals.xcodePlatforms.length > 0) {
      summaryLines.push(`Detected: ${signals.xcodePlatforms.join(", ")} Xcode project (${signals.primaryLanguage ?? "swift"})`);
    } else {
      summaryLines.push(`Detected: ${signals.primaryLanguage ?? "unknown"} project`);
    }
    summaryLines.push("");
    summaryLines.push("Recommended skill packs:");
    if (swiftPacks.length > 0) {
      summaryLines.push(`  Swift: ${swiftPacks.map((p) => p.label).join(", ")}`);
    }
    if (iosPacks.length > 0) {
      summaryLines.push(`  iOS: ${iosPacks.map((p) => p.label).join(", ")}`);
    }
    for (const p of otherPacks) {
      summaryLines.push(`  • ${p.label}: ${p.description}`);
    }

    const totalSkills = toInstall.reduce((n, p) => n + p.skills.length, 0);
    const choice = await showNextAction(ctx, {
      title: "GSD — Install Skills",
      summary: summaryLines,
      actions: [
        {
          id: "install",
          label: "Install recommended skills",
          description: `Install ${totalSkills} skills from ${toInstall.length} pack${toInstall.length > 1 ? "s" : ""} via skills.sh`,
          recommended: true,
        },
        {
          id: "skip",
          label: "Skip",
          description: "Install skills later with npx skills add",
        },
      ],
      notYetMessage: "Run /gsd init when ready.",
    });

    if (choice === "install") {
      const labels = await installPacksBatched(toInstall, (label) => {
        ctx.ui.notify(`Installing ${label} skills...`, "info");
      });
      installed.push(...labels);
      const failed = toInstall.filter((p) => !installed.includes(p.label));
      for (const pack of failed) {
        ctx.ui.notify(`Failed to install ${pack.label} — try manually: npx skills add ${pack.repo}`, "info");
      }
    }
  } else {
    const essentials = SKILL_CATALOG.filter((p) => p.matchAlways && !isPackInstalled(p));
    if (essentials.length === 0) return installed;

    const totalSkills = essentials.reduce((n, p) => n + p.skills.length, 0);
    const choice = await showNextAction(ctx, {
      title: "GSD — Install Essential Skills",
      summary: [
        "GSD will install essential agent skills (skill discovery, authoring,",
        "browser automation, document handling).",
        "",
        "Stack-specific skills (React, Swift, Python, etc.) will be recommended",
        "automatically once your project files are in place.",
      ],
      actions: [
        {
          id: "install",
          label: "Install essentials",
          description: `Install ${totalSkills} essential skills via skills.sh`,
          recommended: true,
        },
        {
          id: "skip",
          label: "Skip",
          description: "Install skills later with npx skills add",
        },
      ],
      notYetMessage: "Run /gsd init when ready.",
    });

    if (choice === "install") {
      const labels = await installPacksBatched(essentials, (label) => {
        ctx.ui.notify(`Installing ${label} skills...`, "info");
      });
      installed.push(...labels);
    }
  }

  if (installed.length > 0) {
    ctx.ui.notify(`Installed: ${installed.join(", ")}`, "info");
  }

  return installed;
}
