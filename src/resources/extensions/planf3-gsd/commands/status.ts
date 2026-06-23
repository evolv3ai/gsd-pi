import { GsdRunner, realSpawner, type Spawner } from "../gsd/headless-runner.ts";
import { mapQuerySnapshot, type BridgeStatus } from "../gsd/status-mapper.ts";

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
  const result = await runner.query();
  return mapQuerySnapshot(result.json);
}
