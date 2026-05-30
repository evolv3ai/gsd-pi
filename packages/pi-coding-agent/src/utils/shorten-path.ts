/** GSD compat: shorten a path for display. */
export function shortenPath(path: unknown): string {
	if (path == null) return "";
	const text = String(path);
	if (text.length <= 48) return text;
	const parts = text.split(/[/\\]/);
	if (parts.length <= 3) return `…${text.slice(-45)}`;
	return `${parts[0]}/…/${parts.slice(-2).join("/")}`;
}
