import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parsePlanf3Html } from "../parser/planf3-html-parser.js";
import { realSpawner } from "../gsd/real-spawner.js";
import type { Spawner } from "../gsd/headless-runner.js";
import { GENERATOR_VERSION } from "../version.js";
import { computeVerdict, signOff } from "./enforce.js";
import { scanEnvVars, guessEnvNames } from "./env-scan.js";
import { projectionHash } from "./hash.js";
import { assembleStageMap } from "./map.js";
import { validateModelIds, type CatalogPort } from "./model-id.js";
import { readPresets, writePresets } from "./presets-file.js";
import { runAuthProbes, runModelPings, type Fetcher } from "./probes.js";
import { projectPreferences } from "./projection.js";
import { renderMap } from "./render.js";
import type { DriftRow, OrchestratorFacts, PresetsRecord, ProbeOutcome, ProductService, StageMap, Verdict } from "./types.js";

export interface PreflightDeps {
  projectRoot: string;
  htmlPath: string | null;
  offline: boolean;
  ping: boolean;
  catalog: CatalogPort;
  orchestrator: OrchestratorFacts | null;
  spawn?: Spawner;
  fetcher?: Fetcher;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
  globalPrefsPath?: string;
  exercisedBuckets?: string[];
}

export interface PreflightRun {
  map: StageMap;
  verdict: Verdict;
  drift: DriftRow[];
  rendered: string;
  record: PresetsRecord | null;
  fresh: PresetsRecord;
  approvalHash: string;
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function spawnLine(spawn: Spawner, cwd: string, cmd: string, args: string[]): Promise<string | null> {
  try {
    const r = await spawn(cmd, args, { cwd });
    const line = r.stdout.trim().split("\n")[0]?.trim();
    return r.exitCode === 0 && line ? line : null;
  } catch {
    return null;
  }
}

/** Scaffolds known to inject env at dev boot (Editorial HN: vite-plugin-neon-new
 *  injected DATABASE_URL with .env moved aside) — statically undetectable, so we
 *  disclaim rather than pretend (spec §9). */
const INJECTION_PRONE_SERVICE_RE = /neon/i;

export async function runPreflight(deps: PreflightDeps): Promise<PreflightRun> {
  const spawn = deps.spawn ?? realSpawner;
  const globalPrefsPath = deps.globalPrefsPath ?? join(homedir(), ".gsd", "PREFERENCES.md");

  // F1: resolve at the deps boundary so `specs/p.html` and `/root/specs/p.html`
  // always compare equal in projectedFrom / planPath comparisons. The pure
  // computeVerdict below still does a raw-string compare — the invariant is
  // "callers always hand resolved paths in".
  const htmlPath = deps.htmlPath !== null ? resolve(deps.projectRoot, deps.htmlPath) : null;

  // Plan-derived inputs (bare preflight: empty policy/commands/integrations).
  let modelPolicy: Record<string, string> = {};
  let validationCommands: string[] = [];
  let integrations: { service: string; envVars: string[] }[] = [];
  let planText = "";
  if (htmlPath !== null) {
    planText = await readFile(htmlPath, "utf8");
    const plan = parsePlanf3Html(planText);
    modelPolicy = plan.modelPolicy as Record<string, string>;
    validationCommands = plan.validationCommands;
    integrations = plan.integrations;
  }

  const projection = projectPreferences({
    globalContent: await readOrNull(globalPrefsPath),
    projectContent: await readOrNull(join(deps.projectRoot, ".gsd", "PREFERENCES.md")),
    modelPolicy,
    validationCommands,
    sourceHtmlPath: htmlPath ?? "(bare preflight)",
  });

  const modelIdIssues = validateModelIds(projection.allModelIds, deps.catalog);

  // Tier 1/2 — projection-scoped: only providers the projection actually uses.
  const providers = [...new Set(Object.values(projection.buckets).map((m) => m.split("/")[0] ?? m))];
  const probeDeps = { fetcher: deps.fetcher, spawn, env: deps.env, now: deps.now };
  const probes: ProbeOutcome[] = deps.offline
    ? []
    : [
        ...(await runAuthProbes(providers, probeDeps)),
        ...(deps.ping ? await runModelPings(projection.buckets, probeDeps) : []),
      ];

  // Product section: declared integrations first; heuristic names (minus the
  // declared ones) as a single `guessed` service (spec §9).
  const product: ProductService[] = [];
  for (const integration of integrations) {
    product.push({
      service: integration.service,
      envVars: await scanEnvVars(integration.envVars, { root: deps.projectRoot, env: deps.env }),
      guessed: false,
      injectionDisclaimer: INJECTION_PRONE_SERVICE_RE.test(integration.service),
    });
  }
  const declared = new Set(integrations.flatMap((i) => i.envVars));
  const guessedNames = guessEnvNames(planText).filter((n) => !declared.has(n));
  if (guessedNames.length > 0) {
    product.push({
      service: "(guessed from plan text)",
      envVars: await scanEnvVars(guessedNames, { root: deps.projectRoot, env: deps.env }),
      guessed: true,
      injectionDisclaimer: false,
    });
  }

  const map = assembleStageMap({
    projection,
    probes,
    modelIdIssues,
    orchestrator: deps.orchestrator,
    gsdBinary: "gsd",
    gsdVersion: await spawnLine(spawn, deps.projectRoot, "gsd", ["--version"]),
    generatorVersion: GENERATOR_VERSION,
    projectRoot: deps.projectRoot,
    gitBranch: await spawnLine(spawn, deps.projectRoot, "git", ["rev-parse", "--abbrev-ref", "HEAD"]),
    product,
    exercisedBuckets: deps.exercisedBuckets,
  });

  const record = await readPresets(deps.projectRoot);
  const { verdict, drift } = computeVerdict(record, { projection, planPath: htmlPath, probes });

  // Manifest wiring check (spec §6.1/§10): does the plan's exported manifest
  // carry the current approval? (siblingPath convention from commands/export.ts)
  if (htmlPath !== null) {
    const manifestPath = htmlPath.replace(/\.html?$/i, ".manifest.json");
    const manifestText = await readOrNull(manifestPath);
    if (manifestText === null) {
      map.validationIssues.push(`manifest: not exported yet (${manifestPath})`);
    } else {
      try {
        const m = JSON.parse(manifestText) as { presets?: { approvalHash: string | null } | null };
        if ((m.presets?.approvalHash ?? null) !== (record?.approval?.approvalHash ?? null)) {
          map.validationIssues.push("manifest: presets stamp is stale — re-run /planf3-gsd-export or the build");
        }
      } catch {
        map.validationIssues.push(`manifest: unreadable JSON (${manifestPath})`);
      }
    }
  }

  const fresh: PresetsRecord = {
    schemaVersion: 1,
    approval: null,
    history: record?.history ?? [],
    stages: {
      orchestrator: map.orchestrator,
      gsdBuild: map.gsdBuild,
      exportStage: map.exportStage,
      project: map.project,
    },
    product: map.product,
    probes: map.probes,
  };
  return {
    map,
    verdict,
    drift,
    rendered: renderMap(map, verdict, drift),
    record,
    fresh,
    approvalHash: projectionHash(projection),
  };
}

export async function signOffPreflight(deps: PreflightDeps, note: string | null): Promise<{ path: string; approvalHash: string }> {
  const run = await runPreflight(deps);
  const projectedFrom = deps.htmlPath !== null ? resolve(deps.projectRoot, deps.htmlPath) : null;
  const signed = signOff({
    base: run.fresh,
    previous: run.record,
    facts: deps.orchestrator,
    note,
    projectedFrom,
    approvalHash: run.approvalHash,
    now: deps.now ?? (() => new Date().toISOString()),
  });
  const path = await writePresets(deps.projectRoot, signed);
  return { path, approvalHash: run.approvalHash };
}
