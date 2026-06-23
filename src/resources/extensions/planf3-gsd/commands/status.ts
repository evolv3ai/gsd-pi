import { GsdRunner, type Spawner } from "../gsd/headless-runner.js";
import { realSpawner } from "../gsd/real-spawner.js";
import { mapQuerySnapshot, type BridgeStatus } from "../gsd/status-mapper.js";
import { friendlyError } from "./error-message.js";

export interface StatusOptions {
  binary?: string;
  cwd?: string;
  spawn?: Spawner;
}

export async function runStatus(opts: StatusOptions = {}): Promise<BridgeStatus> {
  const runner = new GsdRunner({
    binary: opts.binary,
    cwd: opts.cwd ?? process.cwd(),
    spawn: opts.spawn ?? realSpawner,
  });
  try {
    const result = await runner.query();
    return mapQuerySnapshot(result.json);
  } catch (err) {
    throw new Error(friendlyError(err, opts.binary ?? "gsd"));
  }
}
