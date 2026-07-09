/**
 * Resolve the process exit code the CLI should use after `runPrintMode`
 * completes.
 *
 * Print mode previously always exited 0, discarding any `process.exitCode` a
 * slash command or extension handler set during the turn (e.g. a machine
 * readable verdict for a headless orchestrator). Honor a code that was set;
 * default to 0 when none was.
 *
 * Regression: #1293
 */
export function resolvePrintModeExitCode(exitCode: NodeJS.Process['exitCode']) {
  return exitCode ?? 0
}
