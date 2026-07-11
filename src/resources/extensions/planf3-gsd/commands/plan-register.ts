/**
 * Registration layer for /planf3-gsd-plan and /planf3-gsd-run: tokenize
 * args, run the pure logic in plan.ts, inject the prompt via
 * pi.sendUserMessage, emit confirmations/errors. Fire-and-forget by
 * design — never polls or awaits the injected turn.
 */

export interface ParsedRequestArgs {
  request: string;
  flags: Set<string>;
}

/** Strip recognized `--flag` tokens from the raw args string wherever they
 *  appear, preserving the request's internal spacing. Quotes are the
 *  shell/UI's concern and pass through verbatim. */
export function parseRequestArgs(args: string, recognized: readonly string[]): ParsedRequestArgs {
  const flags = new Set<string>();
  let request = args;
  for (const flag of recognized) {
    // (?=\s|$) keeps "--step" from matching inside "--step-unsafe".
    const re = new RegExp(`(?:^|\\s)${flag}(?=\\s|$)`, "g");
    const next = request.replace(re, "");
    if (next !== request) {
      flags.add(flag);
      request = next;
    }
  }
  return { request: request.trim(), flags };
}
