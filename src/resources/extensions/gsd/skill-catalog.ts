/**
 * GSD Skill Catalog — curated skill packs and installation helpers.
 *
 * Data lives in skill-catalog.data.ts; skills.sh install logic in
 * skill-catalog.install.ts.
 */

export {
  SKILL_CATALOG,
  GREENFIELD_STACKS,
  matchPacksForProject,
  type SkillPack,
} from "./skill-catalog.data.js";

export {
  installSkillPack,
  installPacksBatched,
  isPackInstalled,
  runSkillInstallStep,
} from "./skill-catalog.install.js";
