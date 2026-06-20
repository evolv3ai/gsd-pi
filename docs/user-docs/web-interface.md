# Web Interface

> GSD includes a browser-based web interface for project management, real-time progress monitoring, and multi-project support.

## Quick Start

```bash
gsd --web
```

This starts a local web server and opens the GSD dashboard in your default browser.

### CLI Flags

```bash
gsd --web --host 0.0.0.0 --port 8080 --allowed-origins "https://example.com"
```

| Flag | Default | Description |
|------|---------|-------------|
| `--host` | `localhost` | Bind address for the web server |
| `--port` | `3000` | Port for the web server |
| `--allowed-origins` | (none) | Comma-separated list of allowed CORS origins |
| `--no-auth` | disabled | Disable the built-in bearer token gate |

`--no-auth` leaves the web interface unprotected unless another layer controls access. Use it only behind trusted external authentication, such as a reverse proxy, VPN, or private network boundary.

## Features

- **Project management** — view milestones, slices, and tasks in a visual dashboard
- **Real-time progress** — server-sent events push status updates as auto-mode executes
- **Multi-project support** — manage multiple projects from a single browser tab via `?project=` URL parameter
- **Change project root** — switch project directories from the web UI without restarting the server
- **Onboarding flow** — API key setup and provider configuration through the browser
- **Model selection** — switch models and providers from the web UI

## Architecture

The web interface is built with Next.js and communicates with the GSD backend via a bridge service. Each project gets its own bridge instance, providing isolation for concurrent sessions.

Key components:
- `ProjectBridgeService` — per-project command routing and SSE subscription
- `getProjectBridgeServiceForCwd()` — registry returning distinct instances per project path
- `resolveProjectCwd()` — reads `?project=` from request URL or falls back to `GSD_WEB_PROJECT_CWD`

## Configuration

The web server binds to `localhost:3000` by default. Use `--host`, `--port`, and `--allowed-origins` to override (see CLI Flags above).

### Environment Variables

| Variable | Description |
|----------|-------------|
| `GSD_WEB_PROJECT_CWD` | Default project path when `?project=` is not specified |
| `GSD_WEB_NO_AUTH` | Set to `1` to disable the built-in web bearer token gate |

## Node v24 Compatibility

Node v24 introduced breaking changes to type stripping that caused `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` on web boot. This is fixed in a recent release. If you encounter this error, upgrade GSD.

## Auth Token Persistence

the web UI persists the auth token in `sessionStorage` so it survives page refreshes (#1877). Previously, refreshing the page required re-authentication.

## Platform Notes

- **Windows**: The web build is skipped on Windows due to Next.js webpack EPERM issues with system directories. The CLI remains fully functional.
- **macOS/Linux**: Full support.
