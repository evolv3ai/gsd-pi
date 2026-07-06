/**
 * Notification emitter that survives non-interactive sessions.
 *
 * In pi --print mode the extension host substitutes a no-op UI context
 * (runner.js noOpUIContext) so ctx.ui.notify is silently dropped; the host
 * reports that state as ctx.hasUI === false. Mirror every notification to
 * stdout in that case (and in headless/rpc modes, matching gsd core's
 * isInteractiveUIContext logic in shared/next-action-ui.ts).
 */

export interface EmitUI {
  notify(message: string, type?: "info" | "warning" | "error" | "success"): void;
  mode?: string;
}

export interface EmitContext {
  ui: EmitUI;
  hasUI?: boolean;
}

export function shouldMirrorToStdout(ctx: EmitContext, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PLANF3_GSD_STDOUT === "1") return true;
  if (env.PLANF3_GSD_STDOUT === "0") return false;
  if (ctx.hasUI === false) return true;
  if (env.GSD_HEADLESS === "1") return true;
  const mode = ctx.ui.mode;
  if (mode === "rpc" || mode === "headless") return true;
  return false;
}

export function emit(
  ctx: EmitContext,
  message: string,
  type: "info" | "warning" | "error" | "success" = "info",
  write: (chunk: string) => void = (chunk) => { process.stdout.write(chunk); },
): void {
  ctx.ui.notify(message, type);
  if (shouldMirrorToStdout(ctx)) {
    write(`[planf3-gsd] ${message}\n`);
  }
}
