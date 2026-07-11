# planf3-gsd

Bridges a Planf3 HTML plan into a GSD milestone via the headless CLI.

The extension parses a `*.html` plan exported by Planf3, writes a sibling
GSD spec markdown + bridge manifest beside it, then shells out to
`gsd headless new-milestone --context <spec> [--auto]` and
`gsd headless query` to create and track the milestone.

- **Tier:** bundled (ships inside `@opengsd/gsd-pi`)
- **Platform requirement:** `gsd-pi >= 2.29.0`
- **Version:** 0.3.3 (M0+M1 MVP + M2-tier-0 preflight — see [Out of scope](#out-of-scope) for the road from here)

## Quickstart

```sh
# Workspace setup
cd /path/to/your/project
ls my-plan.html                       # the Planf3 export

# 1. Parse the HTML and write spec + manifest beside it (no GSD run yet)
gsd /planf3-gsd-export my-plan.html

# 2. Same as (1) plus: create a GSD milestone from the spec (step mode)
gsd /planf3-gsd-build my-plan.html

# 3. Same as (2) but kick off auto-mode (loops until the milestone completes)
gsd /planf3-gsd-build my-plan.html --auto

# 4. See where the build is at any time
gsd /planf3-gsd-status
```

After `/planf3-gsd-build` the workspace contains:

```
my-plan.html                     # input (unchanged)
my-plan.gsd.md                   # generated GSD spec (rebuilt every export)
my-plan.manifest.json            # bridge manifest — milestone id + mapping (rebuilt every export, milestoneId stamped after build)
.gsd/                            # GSD project state (managed by gsd-pi)
  STATE.md                       # state-machine snapshot
  ...                            # plan tree (legacy `milestones/<MID>/...` on
                                 # gsd-pi <= 1.3.0; flat-phase `phases/NN-slug/`
                                 # on gsd-pi > 1.3.0 — layout owned by gsd-pi)
```

`<stem>.gsd.md` and `<stem>.manifest.json` are siblings of the input
HTML — they go wherever the HTML lives.

## Slash commands

### `/planf3-gsd-export <path-to-plan.html>`

Parse the HTML and write `<stem>.gsd.md` + `<stem>.manifest.json` beside
it. Does not touch GSD state. Re-run to refresh both files after the
Planf3 plan changes.

Notification on success: `Exported → <specPath>\n             <manifestPath>`.

### `/planf3-gsd-build <path-to-plan.html> [--auto] [--no-prefs] [--step-unsafe] [--force]`

Runs export (above), then `gsd headless new-milestone --context
<specPath>` and `gsd headless query`. Writes the resulting milestone id
back into `<stem>.manifest.json` as `gsd.milestoneId`.

- Without `--auto` (**step mode**): refused in headless contexts — the
  spawned `gsd headless new-milestone` parks on the depth-verification
  gate that nothing can answer, leaving a stub milestone. The command
  fails fast with guidance. Pass `--step-unsafe` to restore the old
  behavior anyway, or create the milestone interactively inside pi and
  drive it with `/gsd next`.
- With `--auto`: creates the milestone and runs auto-mode until the
  milestone completes (or is blocked/cancelled). Manifest gets
  `mode: "auto"` and the last-completed milestone id.
- `--force`: skip the preflight gate (records `presets: "forced"` in the eval row).

Notification on success: `Built milestone <id>\nphase=<state>\nspec=<specPath>\nmanifest=<manifestPath>`.

> **Note on auto cost.** `--auto` blocks until the entire GSD auto loop
> finishes — that is real LLM spend on whichever model your GSD
> preferences resolve to. Run step mode first if you want to inspect
> the plan before committing tokens.

### `/planf3-gsd-status`

Calls `gsd headless query` and prints a multi-line block:

```
phase:           <state>
active milestone: <id> (<title>)   |  —
active task:      <id> (<title>)   |  —
progress:         milestones x/y · slices x/y · tasks x/y   |  —
cost:            <float>
next:            <suggested action>   |  —
blockers:        none | <count>
```

`phase` is the GSD state-machine phase string (e.g. `pre-planning`,
`planning`, `evaluating-gates`, `executing`, …) or `unknown` if the
query payload lacked the expected shape.

### `/planf3-gsd-preflight [specs/<plan>.html] [--offline] [--ping] [--check] [--json]`

Maps every pipeline stage (orchestrator → planf3 → export → gsd buckets →
product env) with provider/auth/model per stage. Tier 0 (static) validates every
configured model id — including hand-written `dynamic_routing.tier_models` —
against the model catalog; tier 1 (default) live-probes each provider the
post-overlay projection actually uses (never any other credential on the
machine); tier 2 (`--ping`, opt-in) makes one minimal model call per bucket.
Product env vars are presence-checked across the vite `.env` set
(`.env`, `.env.local`, `.env.<mode>`) and `process.env` — names only, never
values; vars a scaffold injects at boot are disclaimed as not statically
detectable. The signed-off record lives in `specs/PRESETS.md`.

`--check` compares against the signed-off record: `ok` / `drift`
(config drifted out-of-band, or a credential that probed ok at sign-off now
fails) / `unapproved` (no record, or this plan's projection was never signed).
Machine consumers: parse the LAST stdout line — `preflight: verdict=<v>` — or
use the `planf3_gsd_preflight` tool's JSON. Exit codes (0 ok / 20 unapproved /
21 drift / 1 error) are also set but the pi host currently clobbers them in
`--print` mode; the last line is the contract.

**What the approval hash covers.** The hash is a fingerprint of the
**bridge-owned CONFIG**: the post-overlay bucket map + `verification_commands`
(the spec §5.1 "disk-recomputable surface"). It **does not** cover plan text —
adding a phase to a signed plan, rewording a task, or extending the plan body
leaves `verdict=ok` on the next build. That's by design: the gate exists to
catch bridge-owned config drift, not plan authorship.

**Plan-governed buckets self-heal.** If a bucket's model is set by the plan's
`<section id="model-policy">`, editing that model at the project level
(`.gsd/PREFERENCES.md`) is invisible to the gate — the projection re-applies
plan policy at gate time, so the current projection matches the recorded one.
The next build's preferences overlay then rewrites the project file back to
the plan value. To exercise a real config-drift refusal, edit a bucket the
plan **does not** govern (typically an execution or research bucket sourced
from `~/.gsd/PREFERENCES.md`).

## ExtensionAPI tools

For agent/LLM callers (the LLM picks these up automatically from the
tool catalog; they're not a separate user surface).

| Tool | Parameters | Returns (`details`) |
| --- | --- | --- |
| `planf3_gsd_export` | `htmlPath: string`, `mode?: "auto" \| "step"`, `userPrompt?: string` | `{ phaseCount, taskCount, specPath, manifestPath }` |
| `planf3_gsd_status` | none | `BridgeStatus` (see [Status output](#status-output)) |

There is intentionally **no** `planf3_gsd_build` tool. `build` is a
slash-command-only surface — agents that want to create a milestone
should call `gsd headless new-milestone` directly after `planf3_gsd_export`
to keep control over auto vs. step mode.

### Direct-import workaround when the tool isn't discovered (`--print` mode)

The `planf3_gsd_preflight` tool is registered in every activation, but a rare
class of headless/print sessions may not expose the full tool catalog to the
in-session agent. If an agent reports "the `planf3_gsd_preflight` tool isn't
wired in," it can fall back to importing the extension module directly:

```ts
import { signOffPreflight } from ".../src/resources/extensions/planf3-gsd/preflight/run.js";
await signOffPreflight({
  projectRoot: "/abs/path", htmlPath: "specs/plan.html", // relative or absolute — both work as of v0.3.2
  offline: false, ping: false,
  catalog: { ids: () => yourModelIds },
  orchestrator: null,
}, "note-optional");
```

Prior to v0.3.2 the direct-import path had a landmine (path-identity bug F1):
sign-off wrote projectedFrom verbatim and the subsequent gate raw-string
`!==`'d it against the argv path, refusing valid projections when the two
spellings differed. v0.3.2 resolves htmlPath against projectRoot at every
deps boundary, so relative and absolute spellings are now equivalent.

## Bridge manifest schema

Written by `/planf3-gsd-export` (or its `--build` wrapper) at
`<stem>.manifest.json`. Schema version `1`.

```jsonc
{
  "schemaVersion": 1,
  "planf3": {
    "htmlPath": "my-plan.html",
    "title": "<plan title>",
    "created": "<iso8601 | null>",
    "modified": ["<iso8601>", ...]
  },
  "gsd": {
    "specPath": "my-plan.gsd.md",
    "projectRoot": ".",
    "milestoneId": "M001",       // null until /planf3-gsd-build runs
    "headlessSessionId": null,   // reserved for future use
    "mode": "auto" | "step"
  },
  "mapping": {
    "phases": [
      {
        "planf3Selector": "section#phases > div.phase:nth-of-type(1)",
        "title": "<phase title>",
        "gsdMilestone": null,    // reserved for future per-phase milestone mapping
        "gsdSlice": null,        // reserved for future per-phase slice mapping
        "tasks": [
          { "title": "<task title>", "gsdTask": null }
        ]
      }
    ]
  },
  "validation": {
    "commands": ["pnpm test", ...],   // extracted from the Planf3 plan
    "lastSyncedAt": null,
    "lastStatus": "planned" | "running" | "passed" | "failed" | "blocked"
  },
  "provenance": {
    "userPrompt": null,
    "generator": "planf3-gsd-pi",
    "generatorVersion": "0.1.0"
  }
}
```

The `gsd.*` and `mapping.phases[].gsd*` slots are write-once: the
extension fills them in after the matching GSD operation succeeds. Hand
edits to the manifest are clobbered by the next `/planf3-gsd-export`.

## PRESETS worked example

The status column is an evidence ladder, not decoration: `configured` (present
in the projection, nothing verified), `probed-ok` (credential answered a live
probe), `exercised` (a real build dispatched this bucket — only claimed when
evidence is handed in). From the Editorial HN run: `planning: exercised`
(Fable 5, transcript-proven), `execution: exercised` (Sonnet, three sessions),
but `execution_simple: configured` — Haiku was configured all week and never
dispatched once, and `dynamic_routing.tier_models.heavy` likewise never
triggered. A typo in either would have been invisible; that is what tier-0
validation and this ladder exist to say out loud.

## Status output

The `BridgeStatus` shape returned by `planf3_gsd_status` and rendered by
`/planf3-gsd-status`:

```ts
interface BridgeStatus {
  phase: string;                                // "unknown" if missing
  activeMilestone: { id, title } | null;
  lastCompletedMilestone: { id, title } | null;
  activeSlice: { id, title } | null;
  activeTask: { id, title } | null;
  progress: {
    milestones: { done, total },
    slices: { done, total },
    tasks: { done, total }
  } | null;
  cost: number;                                 // total $ across workers
  nextAction: string | null;
  blockers: unknown[];                          // shape passes through
  sessionId: string | null;
}
```

The mapper is tolerant of missing keys — anything absent comes back as
`null`/`0`/`'unknown'` rather than throwing. If GSD ever renames a
top-level key, the status output will silently lose that field; the
extension's compatibility brief in `gsd-pi/CLAUDE.md` tracks this.

## Errors you may see

| Message | What it means | Fix |
| --- | --- | --- |
| `Plan file not found: <path>` | The HTML path you passed doesn't exist | Check the path; relative paths resolve against the workspace cwd |
| `gsd binary not found — is it on your PATH?` | The extension tried to spawn `gsd headless …` and got `ENOENT` | Ensure the `gsd` shim is on PATH (it normally is for any environment that ran the slash command — this fires when the env was sanitized between parent and child) |
| `Built milestone (unknown id) phase=pre-planning` (notification, not an error) | `gsd headless new-milestone` exited 0 but no milestone was actually created (usually the LLM session errored — e.g. provider auth — and the headless run didn't push past pre-planning) | Check `~/.gsd/PREFERENCES.md` model config; inspect the latest session at `~/.gsd/agent/sessions/<project-slug>/` for the real error; the manifest's `milestoneId: null` is the authoritative signal |
| `Refusing headless step mode: …` | You ran `/planf3-gsd-build` without `--auto` | Use `--auto`, drive the milestone interactively, or accept the risk with `--step-unsafe` |
| `preflight gate: …` | No signed-off PRESETS record, or config drifted since sign-off | Run `/planf3-gsd-preflight <plan.html>`, review, sign off (via the preflight skill/tool) — or `--force` |

## Requirements

- `@opengsd/gsd-pi >= 2.29.0` (the extension declares
  `requires.platform: ">=2.29.0"` in `extension-manifest.json`).
- A reachable `gsd` binary on PATH at runtime — the build/status commands
  spawn it as a child process via the headless interface.
- A working GSD model preference. The extension itself doesn't call any
  LLM, but `/planf3-gsd-build` spawns `gsd headless new-milestone` which
  does. If that session errors silently, the manifest will end up with
  `milestoneId: null` — see [Errors](#errors-you-may-see).
- A Planf3 HTML export with the standard structure (the parser keys off
  `section#phases > div.phase:nth-of-type(N)`).

## Out of scope (deferred to later milestones)

The current release covers **M0 (parser + spec exporter)**,
**M1 (manifest + headless bridge)**, and **M2 tier-0 (the preflight/PRESETS
enforced-lite gate)**. The following slash commands and
features are intentionally not implemented yet — see
`/home/wsladmin/dev/planf3-gsd/docs/superpowers/plans/2026-06-22-planf3-gsd-mvp.md`
for the full PRD coverage map:

- `/planf3-gsd plan` and `/run` — rest of M2
- `/sync` (push GSD state back into the Planf3 HTML) — M3
- Steer / pause / stop + the blocker-flow UI — M4
- Lore / RAC promotion — M5

## Where things live

- **Extension source:** `gsd-pi/src/resources/extensions/planf3-gsd/`
- **PRD:** `~/dev/planf3-gsd/planf3-gsd.md`
- **Implementation plan + PRD coverage map:** `~/dev/planf3-gsd/docs/superpowers/plans/2026-06-22-planf3-gsd-mvp.md`
- **SDD ledger + per-task reports:** `gsd-pi/.superpowers/sdd/`
- **Compatibility / monitoring brief:** `~/dev/gsd-pi/CLAUDE.md` (Pointers → planf3-gsd entry, plus the dated smoke entry in Current state)

## Model routing (v0.2.0)

Planf3 plans may carry routing directives; the bridge enforces them at build time:

- **Model Policy** (`<section id="model-policy">` in the plan): maps gsd model phase
  buckets (research, planning, discuss, execution, execution_simple, completion,
  validation, subagent, uat) to model IDs. Merged into `.gsd/PREFERENCES.md`
  `models:` before the milestone is created. Plan wins per-bucket; all other
  preference keys and the markdown body are preserved.
- **Tier chips** (`<code class="tier">[mechanical|standard|complex]</code>` on phase
  `<h3>`/task `<h4>`): advisory hints rendered into the exported spec and recorded in
  the manifest (`mapping.phases[].tier`, `tasks[].tier`) for future per-unit routing.
- **Validation commands**: the plan's global validation checklist is unioned into
  `verification_commands` in `.gsd/PREFERENCES.md`, so GSD executes them as gates.
- **Eval log**: every build appends a JSON line to `.gsd/planf3-gsd-evals.jsonl`
  (phase, cost, progress, blockers, applied models, presets, presetsHash). Presets status is `ok|forced|absent|drift`; failed builds log a row too, with phase markers like failed:export / failed:new-milestone / failed:query / failed:auto-relaunch, plus auto-relaunched / auto-not-started for the auto-chain workaround, plus `preflight-refused:absent` / `preflight-refused:drift` for gated refusals.
  Consumers must partition by `event` before counting: the `{event, phase}`
  space overlaps by design — a settled `--auto` build writes a `build` row
  whose phase is `auto-relaunched` or gsd's real phase (e.g. `done`), and a
  later `/planf3-gsd-status` on the same milestone still appends one `status`
  row (the `hasStatusRowFor` dedup only applies to `status` rows). One
  deliberate gap: refusing headless step mode (the `STEP_MODE_HEADLESS_ERROR`
  guard) throws before any state exists and writes **no** row, so eval-log
  counts never include step-mode attempts.

Skip all preference writes with `/planf3-gsd-build <plan.html> --no-prefs`.
Note: `--no-prefs` skips only the `.gsd/PREFERENCES.md` writes — the build
still appends its eval row to `.gsd/planf3-gsd-evals.jsonl` (pass nothing to
the eval log to opt out; there is intentionally no flag for that).
