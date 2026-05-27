# Hermes × GSD Gateway Setup Checklist

Manual validation before releasing `open-gsd-hermes` 1.0.x. Run on Slack or Telegram with a real GSD project.

## Prerequisites

- [ ] `gsd` installed and in range `>=2.51,<3` (`gsd --version`)
- [ ] `gsd-mcp-server` on PATH or configured in `~/.hermes/gsd.yaml`
- [ ] GSD project initialized (`.gsd/` or `.planning/` present)
- [ ] Hermes gateway running with plugin enabled:
  ```bash
  pip install -e integrations/hermes
  hermes plugins enable open-gsd-hermes
  ```

## Configuration (`~/.hermes/gsd.yaml`)

```yaml
gsd:
  cli_path: /usr/local/bin/gsd
  mcp_server_path: /usr/local/bin/gsd-mcp-server
  credential_source: gsd
  default_project: ~/code/myapp
  bindings:
    slack:
      "#your-channel": ~/code/myapp
  poll_interval_seconds: 12
  cache_ttl_seconds: 45
  notification_level: normal
```

## Checklist

### Bind

- [ ] Send `/gsd bind /absolute/path/to/project`
- [ ] Expect confirmation with resolved path
- [ ] Send `/gsd status` — snapshot shows active milestone/slice/phase

### Auto + supervision

- [ ] Send `/gsd auto`
- [ ] Expect session id in reply
- [ ] Observe progress notifications on unit transitions (normal/verbose level)
- [ ] `pre_llm_call` context includes GSD snapshot in agent turns (verbose logging)

### Blocker reply

- [ ] When auto mode blocks, receive notification with `/gsd reply` hint
- [ ] Send `/gsd reply <answer>`
- [ ] Session resumes (status no longer blocked)

### Cancel

- [ ] Send `/gsd cancel` while running
- [ ] Expect cancellation confirmation
- [ ] No further transition notifications

### Fail closed

- [ ] New chat without bind/default — `/gsd auto` returns actionable bind error

## Cron (6b)

- [ ] `hermes-gsd-cron ~/code/myapp` exits 0 or documented code on empty queue
- [ ] Hermes cron job `deliver:` posts completion to home channel

## Memory + read CLI (6c)

- [ ] `gsd read progress --json --project <path>` returns `integration_version: 1`
- [ ] Memory prefetch includes GSD memories for keyword query

## Troubleshooting

| Symptom | Check |
|---------|--------|
| Version error on start | `gsd --version` in supported range |
| MCP spawn fails | `gsd-mcp-server` path, `GSD_CLI_PATH` |
| No notifications | Session key format `agent:main:{platform}:{chat_type}:{chat_id}` |
| Cancel ignored | `gsd_cancel_by_project` available on MCP server |

## Upstream Hermes PR

See [`upstream-hermes-pr.md`](upstream-hermes-pr.md) for documentation PR steps to Nous Research Hermes repo.
