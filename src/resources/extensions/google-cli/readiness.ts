import { spawnSync } from "node:child_process";

function isCommandInPath(command: string): boolean {
	const resolver = process.platform === "win32" ? "where" : "which";
	const result = spawnSync(resolver, [command], { stdio: "ignore" });
	return result.status === 0;
}

export function isGeminiCliReady(): boolean {
	return isCommandInPath("gemini");
}

export function isAntigravityCliReady(): boolean {
	return isCommandInPath("agy");
}
