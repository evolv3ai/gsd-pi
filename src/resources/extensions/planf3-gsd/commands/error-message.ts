/**
 * Maps thrown errors to user-friendly messages for planf3-gsd commands/tools.
 */

interface NodeError extends Error {
  code?: string;
  syscall?: string;
  path?: string;
}

export function friendlyError(err: unknown, binary?: string): string {
  const e = err as NodeError;
  if (e?.code === "ENOENT") {
    // Spawn ENOENT: the binary itself was not found
    if (e.syscall === "spawn" || (binary !== undefined && e.path === binary)) {
      return `gsd binary not found — is it on your PATH?`;
    }
    // File ENOENT: the HTML / spec path was not found
    const filePath = e.path ?? "(unknown path)";
    return `Plan file not found: ${filePath}`;
  }
  if (e instanceof Error) return e.message;
  return String(err);
}
