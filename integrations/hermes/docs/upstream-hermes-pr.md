# Upstream Hermes Documentation PR (6c)

Open GSD does **not** transfer plugin ownership to Nous Research. Submit a documentation-only PR to the Hermes Agent repository.

## PR title

`docs: add GSD Pi integration guide (open-gsd-hermes)`

## Files to add/change

1. **`docs/integrations/gsd-pi.md`** — overview linking to this monorepo and PyPI package
2. **`docs/examples/gsd-config.yaml`** — example `~/.hermes/gsd.yaml` snippet
3. **`docs/guides/build-a-hermes-plugin.md`** — cross-link note: use `pre_llm_call` for snapshots, not `ContextEngine`

## Example config snippet

```yaml
plugins:
  - open-gsd-hermes

gsd:
  cli_path: gsd
  mcp_server_path: gsd-mcp-server
  credential_source: gsd
  default_project: ~/projects/my-app
```

## Version pairing table

| open-gsd-hermes | gsd |
|-----------------|-----|
| 1.0.x | >=2.51,<3 |
| 1.1.x | >=2.52,<3 |
| 1.2.x | >=2.53,<3 |

## Reviewer notes

- Orchestration uses **`gsd-mcp-server`**, not `gsd --mode mcp`
- Gateway notifications use **`send_message`** dispatch, not `inject_message`
- Blocker resolution: **`/gsd reply`** (primary); optional thread capture in 6c
