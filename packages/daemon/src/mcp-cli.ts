#!/usr/bin/env node
import { handleCloudRuntimeCommand } from "./cloud-cli.js";

handleCloudRuntimeCommand(process.argv.slice(2), { binaryName: "gsd-mcp" }).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`gsd-mcp: fatal: ${msg}\n`);
  process.exit(1);
});
