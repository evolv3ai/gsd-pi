/**
 * Strip a leading ID prefix (e.g. "M001: " or "S04: ") from a title
 * to prevent double-prefixing when the renderer adds its own prefix.
 * Handles repeated prefixes (e.g. "M001: M001: M001: Title" → "Title").
 */
export function stripIdPrefix(title: string, id: string): string {
  const prefix = `${id}: `;
  let result = title;
  while (result.startsWith(prefix)) {
    result = result.slice(prefix.length);
  }
  return result.trim() || title;
}
