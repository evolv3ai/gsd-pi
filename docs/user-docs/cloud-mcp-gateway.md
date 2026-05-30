# Cloud MCP Gateway

The Cloud MCP Gateway lets a hosted MCP client call GSD workflow tools through a local runtime. Use it when the MCP client cannot reach your workstation directly, but your workstation can open an outbound WebSocket connection to a gateway.

The reader for this guide is an operator setting up a gateway and a local runtime. After reading it, they should be able to start the gateway, pair one runtime, connect it, and confirm that MCP tool calls can reach local projects.

## Architecture

The gateway exposes two HTTP surfaces:

- An authenticated MCP endpoint for remote MCP clients.
- A pairing endpoint that issues one-time runtime device tokens.

The local runtime runs under `gsd-daemon`. After pairing, it stores the gateway URL, runtime ID, and device token in the daemon config. When `gsd-daemon cloud connect` starts, it connects back to the gateway with the device token, advertises local projects, and forwards tool calls to the local GSD runtime.

## Gateway Requirements

Run the gateway with Node 22 or newer. The gateway listens on port `8787` by default.

Set `GSD_CLOUD_USER_TOKEN` before starting the gateway. Remote MCP clients and pairing-code requests use this value as a bearer token.

```bash
export GSD_CLOUD_USER_TOKEN="replace-with-a-long-random-token"
gsd-cloud-mcp-gateway --port 8787
```

The process prints the listen URL on startup. In local development, the default URL is `http://localhost:8787`. In production, put TLS and any public routing in front of the gateway, then give clients the public HTTPS URL.

## Pair a Local Runtime

First create a pairing code with the user token:

```bash
curl -sS -X POST "https://gateway.example.com/pairing-codes" \
  -H "Authorization: Bearer $GSD_CLOUD_USER_TOKEN"
```

The response contains a short code and an expiration timestamp. Pair the local runtime before the code expires:

```bash
gsd-daemon cloud pair \
  --gateway "https://gateway.example.com" \
  --code "PAIRING_CODE" \
  --runtime-name "Laptop"
```

Pairing saves the cloud runtime fields in the daemon config and enables cloud runtime mode. The stored device token is secret. Use the status command when you need to inspect the config safely:

```bash
gsd-daemon cloud status
```

To remove the local cloud runtime credentials:

```bash
gsd-daemon cloud disconnect
```

## Connect the Runtime

Start the local runtime connection:

```bash
gsd-daemon cloud connect --verbose
```

The runtime connects to `/runtime/connect` on the gateway with the saved device token. HTTPS gateway URLs become secure WebSocket URLs automatically. If the connection drops, the runtime retries periodically.

The runtime advertises projects discovered by the daemon. Remote MCP callers can list the advertised projects with `gsd_cloud_projects`, then pass `projectAlias` or `runtimeId` when calling a forwarded GSD tool.

## Configure a Remote MCP Client

Point the client at the gateway MCP endpoint and pass the user token as a bearer token:

```text
URL: https://gateway.example.com/mcp
Authorization: Bearer <GSD_CLOUD_USER_TOKEN>
```

The gateway forwards GSD session tools and workflow tools to an online local runtime. When multiple runtimes are connected, provide `runtimeId` or `projectAlias` so the gateway can route the call.

## Failure Expectations

- `401 Unauthorized`: the user token or device token is missing, invalid, or revoked.
- `400 Pairing code is invalid or expired`: the code was mistyped, already used, or expired.
- `No Local GSD Runtime is connected`: the gateway is running, but no paired runtime is online.
- `runtimeId or projectAlias is required`: more than one runtime is online and the call did not identify a target.
- Tool call timeout: the runtime accepted the call but did not answer before the gateway timeout.

Treat user tokens and device tokens like passwords. Do not commit them to project files or paste them into issue trackers.
