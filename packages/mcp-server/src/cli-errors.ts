type GlobalErrorEvent = 'uncaughtException' | 'unhandledRejection';

interface GlobalErrorRuntime {
  on(event: GlobalErrorEvent, listener: (error: unknown) => void): unknown;
  stderr: {
    write(message: string): unknown;
  };
  exit(code: number): never;
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  return String(error);
}

/**
 * Install process-global error handlers that log and then terminate.
 *
 * A repeating throw against a dead stdio transport (e.g. an orphaned server
 * whose parent pipe has closed) would otherwise log-and-loop, pegging the CPU
 * indefinitely because the handler returns without exiting. Terminating after
 * logging guarantees the process crashes out of the loop; the client (Claude
 * Code) owns restart/backoff, and the PID registry sweep cleans up the stale
 * entry on the next spawn. See #783.
 */
export function installGlobalErrorHandlers(runtime: GlobalErrorRuntime = process as unknown as GlobalErrorRuntime): void {
  runtime.on('uncaughtException', (error) => {
    runtime.stderr.write(`[gsd-mcp-server] Uncaught exception: ${formatUnknownError(error)}\n`);
    runtime.exit(1);
  });

  runtime.on('unhandledRejection', (reason) => {
    runtime.stderr.write(`[gsd-mcp-server] Unhandled rejection: ${formatUnknownError(reason)}\n`);
    runtime.exit(1);
  });
}
