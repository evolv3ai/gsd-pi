import type { ChildProcess } from "node:child_process";

const FORCE_KILL_AFTER_MS = 2_000;

/** Send a signal to a child process, then SIGKILL if it is still alive. */
export function killChildProcess(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill(signal);

  if (signal !== "SIGTERM") {
    return;
  }

  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, FORCE_KILL_AFTER_MS);
}
