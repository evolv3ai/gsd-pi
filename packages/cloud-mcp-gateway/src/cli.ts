#!/usr/bin/env node
import { listenGateway } from "./server.js";

const portArg = process.argv.indexOf("--port");
const authStoreArg = process.argv.indexOf("--auth-store");
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : undefined;
const authStorePath = authStoreArg >= 0 ? process.argv[authStoreArg + 1] : undefined;

listenGateway({ port, authStorePath }).then(({ url }) => {
  process.stderr.write(`[gsd-cloud-mcp-gateway] listening on ${url}\n`);
}).catch((err) => {
  process.stderr.write(`[gsd-cloud-mcp-gateway] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
