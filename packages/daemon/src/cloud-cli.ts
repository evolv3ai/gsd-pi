import { parseArgs } from "node:util";
import { resolveConfigPath, loadConfig } from "./config.js";
import { Logger } from "./logger.js";
import { Daemon } from "./daemon.js";
import { clearCloudConfig, exchangePairingCode, redactedCloudStatus, saveCloudConfig } from "./cloud-config.js";

export const CLOUD_COMMAND_USAGE = `Commands:
  status [--config <path>]
  pair --gateway <url> --code <code> [--runtime-name <name>] [--config <path>]
  connect [--config <path>] [--verbose]
  disconnect [--config <path>]
`;

export async function handleCloudRuntimeCommand(argv: string[], opts: {
  binaryName: string;
  nestedCommandName?: string;
}): Promise<void> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(formatCloudRuntimeUsage(opts.binaryName, opts.nestedCommandName));
    process.exit(0);
  }

  const command = argv[0];
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      config: { type: "string", short: "c" },
      gateway: { type: "string" },
      code: { type: "string" },
      "runtime-name": { type: "string" },
      verbose: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help || !command) {
    process.stdout.write(formatCloudRuntimeUsage(opts.binaryName, opts.nestedCommandName));
    process.exit(0);
  }

  const configPath = resolveConfigPath(values.config);
  if (command === "status") {
    process.stdout.write(`${JSON.stringify(redactedCloudStatus(loadConfig(configPath)), null, 2)}\n`);
    return;
  }

  if (command === "disconnect") {
    clearCloudConfig(configPath);
    process.stdout.write(`${opts.binaryName}: cloud runtime disconnected locally.\n`);
    return;
  }

  if (command === "pair") {
    if (!values.gateway || !values.code) {
      throw new Error("pair requires --gateway and --code");
    }
    const runtimeName = values["runtime-name"];
    const result = await exchangePairingCode({
      gatewayUrl: values.gateway,
      code: values.code,
      runtimeName,
    });
    saveCloudConfig(configPath, {
      gateway_url: values.gateway,
      device_token: result.deviceToken,
      runtime_id: result.runtimeId,
      ...(runtimeName ? { runtime_name: runtimeName } : {}),
      enabled: true,
    });
    process.stdout.write(`${opts.binaryName}: paired cloud runtime ${result.runtimeId}.\n`);
    return;
  }

  if (command === "connect") {
    const config = loadConfig(configPath);
    if (!config.cloud?.device_token || !config.cloud.runtime_id) {
      throw new Error("cloud runtime is not paired; run `pair` first");
    }
    const logger = new Logger({
      filePath: config.log.file,
      level: config.log.level,
      verbose: values.verbose,
    });
    const daemon = new Daemon(config, logger);
    await daemon.start();
    return;
  }

  throw new Error(`Unknown cloud runtime command: ${command}`);
}

export function formatCloudRuntimeUsage(binaryName: string, nestedCommandName?: string): string {
  const prefix = nestedCommandName ? `${binaryName} ${nestedCommandName}` : binaryName;
  return `Usage: ${prefix} status [--config <path>]
       ${prefix} pair --gateway <url> --code <code> [--runtime-name <name>] [--config <path>]
       ${prefix} connect [--config <path>] [--verbose]
       ${prefix} disconnect [--config <path>]

Options:
  --config <path>        Path to YAML config file (default: ~/.gsd/daemon.yaml)
  --gateway <url>        Cloud MCP Gateway URL
  --code <code>          Pairing code from the Cloud MCP Gateway
  --runtime-name <name>  Friendly name for this Local GSD Runtime
  --verbose              Print log entries to stderr in addition to the log file
  --help                 Show this help message and exit
`;
}
