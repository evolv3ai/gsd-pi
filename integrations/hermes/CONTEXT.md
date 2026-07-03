# CONTEXT — open-gsd-hermes plugin

A bounded context: the Hermes Agent chat gateway to GSD Pi. This is a glossary,
not a spec. Implementation decisions live in code; cross-cutting decisions that
are hard to reverse and surprising without context live as ADRs.

## Domain glossary

- **GSD command surface (chat)**: the set of `/gsd` subcommands the plugin exposes
  over a chat gateway (WeChat/Telegram/Slack). Today: `bind`, `status`, `auto`,
  `cancel`, `reply`, `help`. A `new-milestone` subcommand is the active addition.
- **Binding resolution**: the tiered lookup (cron → slash arg → session bind →
  channel map → profile default → cwd heuristic) that resolves a chat command to
  a concrete `projectDir`. Owned by `binding.py`. Fails closed with `BindingError`
  when no GSD project can be found.
- **Supervisor context**: the shared, mutable, in-process state
  (`SupervisorContext`) recording the active GSD session's `session_id`,
  `project_dir`, and `state` (`IDLE`/`RUNNING`/`BLOCKED`/`COMPLETE`/`FAILED`/
  `CANCELLED`). Read by `/gsd status`, `/gsd cancel`, and the co-run gate; driven
  (written) by whichever mechanism owns the active session — the poll-driven
  `SupervisorFsm` for `/gsd auto`, or a stream-reader for milestone creation.
- **Co-run guard**: the rule that two mutating GSD operations must not run against
  the same project at once. Enforced locally in the plugin by checking
  `SupervisorContext.state` before starting either a `new-milestone` or `auto`
  run. The upstream lease layer (CHANGELOG:509, open) is the backstop, not the
  plugin's responsibility — the plugin refuses when *it* knows a session is live.
- **Fire-and-track (delivery model)**: the plugin's fundamental response shape —
  a mutating command returns a one-line ack immediately, and all subsequent
  progress/blocker/terminal updates are *pushed* to the chat via
  `NotificationService` → `send_message` on a background thread. Required because
  the target chat platforms do not hold a single request/response open for the
  minutes-to-hours a GSD operation takes.
- **Stream-driven session (milestone path)**: a GSD run driven by consuming the
  `--output-format stream-json` event stream of a CLI subprocess owned by the
  plugin, rather than by polling `gsd_status`. Distinct from the **poll-driven
  session** (`/gsd auto` via MCP `gsd_execute`), where `SupervisorFsm._tick`
  periodically calls `gsd_status`/`gsd read progress`. The two differ at the
  source (CLI subprocess vs MCP-managed RPC session) and honestly reflect that
  difference in their drivers; `SupervisorContext` is the shared state both
  write.
- **Subprocess ownership (milestone path)**: because the plugin spawns
  `gsd headless new-milestone` directly, the plugin — not the MCP server — owns
  that process's full lifecycle: cancel (SIGTERM), blocker replies (stdin), and
  terminal/transition notifications (stdout stream). The MCP session manager
  cannot see or reach a process it did not start; there is no `auto.lock` pid
  backstop during the planning phase (the lock is an auto-loop concept written
  only once `--auto` chains in).
