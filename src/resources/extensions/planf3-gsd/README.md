# planf3-gsd

Bridges a Planf3 HTML plan into a GSD milestone via the headless CLI.

The extension parses a `*.html` plan exported by Planf3, writes a sibling
GSD spec markdown + bridge manifest beside it, then shells out to
`gsd headless new-milestone --context <spec> [--auto]` and
`gsd headless query` to create and track the milestone.

- **Tier:** bundled (ships inside `@opengsd/gsd-pi`)
- **Platform requirement:** `gsd-pi >= 2.29.0`
- **Version:** 0.6.1 (M0+M1+M2 complete — plan/run/build/preflight; + M3 sync; + M4 loop/steer; + F-4.2 CLI-provider fallback; + F5.1-2 sign-off token hardening; + F6.0-5..8 acceptance fixes; see [Out of scope](#out-of-scope) for the road from here)

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

# 5. No HTML yet? Plan from a request (agent runs planf3, then exports)
gsd /planf3-gsd-plan "add dark mode to settings"

# 6. End-to-end: plan, export, create milestone, start GSD auto mode
gsd /planf3-gsd-run "add dark mode to settings"
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

### `/planf3-gsd-plan "<request>" [--questionable]`

Validates preconditions (planf3 skill present — `./.claude/skills/planf3/SKILL.md`,
then `~/.claude/skills/planf3/SKILL.md`; non-empty request), then queues a
prompt into the **host pi session** (`deliverAs: "followUp"`) instructing the
agent to: read the planf3 skill, produce the HTML plan under `specs/`, and
chain into the `planf3_gsd_export` tool. Result: `specs/<name>.html` +
`.gsd.md` + `.manifest.json`, **no milestone**.

- `--questionable`: planf3's Q&A-section mode — assumptions land in the
  document instead of interactive questions (recommended when you don't want
  the queued turn to stall on questions).
- **Fire-and-forget:** the command cannot await the agent's compliance. It
  reports what was injected; observe progress via the agent's reply and
  `/planf3-gsd-status`.
- If the planf3 skill is missing, the command prints install guidance and
  injects nothing. (The GSD/Pi bundled skill registry is not probed — planf3
  is not bundled.)
- Under hosts that tunnel turns through an external CLI (`claude-code`,
  `cursor-cli`), pi-session tools are not visible to the model; the injected
  prompt therefore includes a Bash fallback via `gsd --print
  '/planf3-gsd-export …'`. Note also: in fully headless `--print` sessions
  the queued planning turn never executes at all (fire-and-forget contract —
  the injection is only consumed by a live interactive session).

### `/planf3-gsd-run "<request>" [--step] [--questionable] [--no-prefs] [--force] [--step-unsafe]`

Same planning turn as `/planf3-gsd-plan`, but the chain instruction targets
the `planf3_gsd_build` tool (build subsumes export): the agent plans, then
builds the milestone end-to-end. Flags map onto the build surface:
`--step` → `auto=false`, `--no-prefs` → `applyPrefs=false`, `--force` and
`--step-unsafe` pass through. `--step` without `--step-unsafe` will hit
`runBuild`'s step-mode safety gate at tool time — by design.

Same fire-and-forget contract; additionally observe
`.gsd/planf3-gsd-evals.jsonl` (the chained build appends its usual eval row —
the planning phase itself never logs rows).

Under hosts that tunnel turns through an external CLI (`claude-code`,
`cursor-cli`), pi-session tools are not visible to the model; the injected
prompt therefore includes a Bash fallback via `gsd --print
'/planf3-gsd-build …'`. Note also: in fully headless `--print` sessions the
queued planning turn never executes at all (fire-and-forget contract — the
injection is only consumed by a live interactive session).

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

### `/planf3-gsd-sync [specs/<plan>.html] [--dry-run]`

Pulls GSD runtime state back into the Planf3 HTML plan — the reverse
direction of `export`/`build`. Reads `gsd headless query` (the documented
surface only — never `.gsd/` internals), then rewrites the plan surgically:

- **Status markers** (`[]` / `[wip]` / `[x]` / `[f]`) move **forward only**
  (`todo < wip < failed < done`): re-running sync is a no-op, a hand-set
  `[x]` survives a `[wip]` snapshot, and a previously-`[f]` unit is upgraded
  to `[x]` by milestone completion. A completed milestone sweeps every
  marker to `[x]`; an active one paints the matched phase/item `[wip]`
  (or `[f]` when the snapshot reports blockers).
- **Bridge metadata**: appends the sync timestamp to the `modified` list and
  upserts `gsd milestone` / `gsd session` rows in the header `<dl>`.
- Everything else — HTML, CSS, images, notes, amendments — is byte-identical
  (string-level splices, no DOM re-serialization; atomic temp+rename write).

With no path, the plan is inferred from `specs/*.manifest.json` (exactly one
manifest wins; several → pass the path explicitly). The manifest supplies the
milestone id; if the snapshot shows a different milestone, sync reports
"not observable" and writes nothing. Active slice/task titles that can't be
uniquely matched to a phase/item are listed as `unmatched:` and never painted.
`--dry-run` prints every would-be change and writes nothing.

Not synced yet (no documented headless source): commit SHAs and
validation-evidence summaries — deferred until upstream exposes a
ledger/artifact query.

### Correlation ladder

`/planf3-gsd-sync` maps a live GSD active-slice/active-task snapshot back
onto a plan phase/item through a fixed ladder — the first rung that
produces a **unique** answer wins:

1. **Persisted binding** — a stored `gsdSlice`/`gsdTask` mapping from an
   earlier sync. Stored bindings win outright; nothing re-matches.
2. **PF3 tag** — a `PF3-P<n>` / `PF3-P<n>-T<m>` tag on the GSD-minted
   title (see [Stable-ID planner tags](#stable-id-planner-tags) below).
   Exactly one distinct tag required.
3. **Title rules** — normalized-equality then unique-substring matching
   against phase/checklist-item/task-heading text (unchanged since M3).
4. **Singleton ordinal** — **slice level only**: exactly one phase in the
   plan and exactly one slice total. There is deliberately no task-level
   ordinal rung.
5. **Unmatched** — nothing painted; the title is listed in the sync
   summary as `unmatched:`.

A successful match at rungs 2–4 is persisted into the manifest so the
next sync short-circuits at rung 1. Re-running `/planf3-gsd-export`
regenerates the manifest from scratch and therefore **clears all
bindings** — expected, since a re-export implies the plan (and its PF3
IDs) may have changed.

### Stable-ID planner tags

Every exported spec (`/planf3-gsd-export`, `/planf3-gsd-build`, `/planf3-gsd-run`)
carries this instruction so the planning agent tags the slices/tasks it
creates with the source phase/task IDs:

> **Unit tags:** When decomposing this spec into slices and tasks, include the source tag
> (e.g. `[PF3-P1]`) verbatim at the end of the corresponding slice/task titles.
> Do not invent tags for units with no source phase.

`PF3-P<n>` addresses the plan phase at document index `n-1`; `PF3-P<n>-T<m>`
addresses task `m-1` within it. IDs are a pure function of the parsed plan,
so the same plan always yields the same tags.

### The sync loop (custody pattern)

There is no daemon or background poller — a human or orchestrating agent
holds custody of the loop and drives it explicitly:

1. `/planf3-gsd-build <plan.html> --auto` paints the first live state onto
   the plan automatically when it returns (a "build-return sync" — no
   separate `/planf3-gsd-sync` call needed for that first snapshot).
2. Each subsequent custody round is two calls: `gsd headless auto` (or
   `gsd headless next` in step mode), then `/planf3-gsd-sync` to paint
   the result onto the plan.
3. `/planf3-gsd-status` nudges when it detects markers have fallen behind
   the live snapshot (completed work the plan still shows as `[]`):
   `markers behind live state — run /planf3-gsd-sync`. The nudge only
   fires while the plan still shows **zero** done markers — once a single
   marker has painted, silence no longer means the rest are current; it
   just means this particular check stopped looking.

- **Staleness nudge (extended in 0.6.1, F6.0-7):** also fires when the
  milestone is already completed but the plan was never swept
  (`lastCompletedMilestone` owns the manifest, zero done markers).
- **Sync (extended in 0.6.1, F6.0-8):** the completion sweep upserts
  `validation.lastStatus: "passed"` and `validation.lastSyncedAt` into the
  manifest alongside binding persistence (same atomic write; idempotent).

### Steer, pause, resume, stop

Thin passthroughs to the documented `gsd headless <cmd>` surface —
they never read `.gsd/` internals.

| Command | What it does |
| --- | --- |
| `/planf3-gsd-steer "<instruction>"` | Sends one steering instruction into the running headless build (`gsd headless steer`). **Eval-logged** — it redirects paid work in progress. Empty/whitespace instruction is refused with usage, nothing spawned. |
| `/planf3-gsd-pause` | Pauses the running headless build (`gsd headless pause`). Flow control only — no eval row. |
| `/planf3-gsd-resume [path]` | Resumes a paused build with **one bounded round**: reads the manifest's `gsd.mode` and runs `gsd headless auto` when mode is `auto`, or `gsd headless next` when mode is `step`. Always prints the custody reminder to run `/planf3-gsd-sync` after the round — long runs stay under orchestrator custody, not inside a single resume call. |
| `/planf3-gsd-stop` | Stops the running headless build (`gsd headless stop`). **Eval-logged** — it abandons work in progress. |

## ExtensionAPI tools

For agent/LLM callers (the LLM picks these up automatically from the
tool catalog; they're not a separate user surface).

| Tool | Parameters | Returns (`details`) |
| --- | --- | --- |
| `planf3_gsd_export` | `htmlPath: string`, `mode?: "auto" \| "step"`, `userPrompt?: string` | `{ phaseCount, taskCount, specPath, manifestPath }` |
| `planf3_gsd_status` | none | `{ status: BridgeStatus, nudge: string \| null }` (see [Status output](#status-output)) |
| `planf3_gsd_build` | `htmlPath: string`, `auto?: boolean` (default true), `applyPrefs?: boolean` (default true), `force?: boolean`, `allowUnsafeStep?: boolean` | `{ milestoneId, phase, autoChain, specPath, manifestPath, presets }` |
| `planf3_gsd_sync` | `htmlPath?: string`, `dryRun?: boolean` | `SyncOutcome` (`{ kind, message, applied, unmatched }`) |

`planf3_gsd_build` (new in v0.4.0) wraps the same `runBuild` path as the
slash command — preflight/PRESETS gate, preferences overlay, eval rows, and
the idle guard all apply identically. It exists primarily as the chain target
for `/planf3-gsd-run`; `auto` defaults to `true`, and step mode still
requires `allowUnsafeStep` just like the command.

- **Idle guard (changed in 0.6.1, F6.0-5):** `gsd headless --output-format json`
  children buffer all stdout until exit, so the guard no longer treats stdout
  silence as a hang. Liveness comes from a metadata-only probe of `.gsd`
  (`fs.stat` mtimes on the db/journal/activity paths every 30s — the bridge's
  one narrow carve-out from "never consume `.gsd/` internals": stat-only,
  never content, best-effort). The 10-minute default now measures genuine
  no-progress; `headlessIdleMs: 0` still disables everything.

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
}, "note-optional", humanApprovalToken); // v0.5.2: token REQUIRED — see below
```

### Sign-off requires a human approval token (v0.5.2, F5.1-2)

Sign-off is no longer a boolean an agent can set. The flow:

1. A human runs `/planf3-gsd-preflight` in the **console**. When the verdict is
   `unapproved` or `drift`, the command mints a single-use token (30-minute
   TTL, sha256-only on disk at `.gsd/planf3-gsd-pending-approval.json`) and
   prints `approval token: <tok> — …` above the verdict trailer.
2. The human either runs `/planf3-gsd-preflight --sign-off <tok>` themselves,
   or relays the token to the agent, which passes it as the tool's
   `approvalToken` param alongside `signOff: true`.
3. The token is consumed on success; a wrong token leaves it valid; if the
   workflow map changed since issue, sign-off refuses (`stale-map`) and the
   human must re-approve the new map.

- **Sign-off (changed in 0.6.1, F6.0-6):** the minted-token hint prints the
  full command including the plan path, and the token is scoped to that
  projection — consuming it bare (or with a different path) is refused
  without burning the token, and the refusal echoes the corrected command.
  The pending-approval file is schema v2 (`projectedFrom`).

The tool surface never mints, returns, or logs a token — `signOff: true`
without a valid relayed token is refused with instructions to involve the
human. Rationale: e2e F-5.1 observed an agent making unprompted
`signOff=true` attempts, one with a fabricated human-approval claim. Residual
risk (documented, out of scope): an agent with unrestricted shell can still
run the console command itself and read the token from stdout — that is a
deliberate, auditable circumvention rather than a one-parameter slip.

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

`planf3_gsd_status` returns a `StatusReport` in `details`:

```ts
interface StatusReport {
  status: BridgeStatus;
  nudge: string | null;                         // M4 staleness nudge, or null
}
```

**Changed in 0.6.0**: fields that used to sit at the top level of
`details` (`phase`, `activeMilestone`, `progress`, ...) now live under
`details.status`; `details.nudge` is new. `/planf3-gsd-status` (the
slash command) is unaffected — it renders the same text either way.

`status` is the `BridgeStatus` shape:

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

`nudge` is the M4 staleness nudge (see [The sync loop](#the-sync-loop-custody-pattern)):
either `"markers behind live state — run /planf3-gsd-sync"` or `null`.
It only fires while the plan still shows zero done markers, so `null`
means "not detected as behind," not "confirmed current."

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
**M1 (manifest + headless bridge)**, **M2 (preflight + plan/run)**,
**M3 (`/planf3-gsd-sync`)**, and **M4 (custody sync loop, PF3
stable-ID correlation ladder, steer/pause/resume/stop)**. The
following remains intentionally not implemented — see
`/home/wsladmin/dev/planf3-gsd/docs/superpowers/plans/2026-06-22-planf3-gsd-mvp.md`
for the full PRD coverage map:

- FR-8 deferred fields — GSD session id / commit-SHA list / validation-evidence
  summaries in plan metadata — blocked on upstream exposing a documented
  headless ledger/artifact query (same named follow-up since M3)
- Lore / RAC promotion — M5 (optional, v1+)

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
