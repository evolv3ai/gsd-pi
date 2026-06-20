// Project/App: gsd-pi
// File Purpose: Extracted from interactive-mode.ts (Phase E2 seam remediation).
// @ts-nocheck

import * as path from "node:path";
import { Text } from "@gsd/pi-tui";
import { APP_NAME } from "@gsd/pi-coding-agent/config.js";
import { theme } from "@gsd/pi-coding-agent/theme/theme.js";
import { getChangelogForDisplay } from "./interactive-startup.js";
import type { InteractiveModeDelegateHost } from "./interactive-mode-delegate-host.js";

export { getChangelogForDisplay, checkForNewVersion, checkTmuxKeyboardSetup } from "./interactive-startup.js";

export function installStdinErrorRecovery(host: InteractiveModeDelegateHost): void {
	if (host.stdinErrorHandler) return;
	host.stdinErrorHandler = (err: Error) => {
		const errno = err as NodeJS.ErrnoException;
		const isReadEio = errno.code === "EIO" || /read EIO/i.test(err.message);
		if (!isReadEio) return;

		process.stderr.write(`[pi] stdin EIO detected, aborting active stream\n`);
		if (host.session.isStreaming) {
			host.agent.abort();
			host.showWarning("Terminal input was interrupted (EIO). Aborted the active response; send your message again.");
		}
	};
	process.stdin.on("error", host.stdinErrorHandler);
}

export function mountStartupHeader(host: InteractiveModeDelegateHost): void {
	const logo = theme.bold(theme.fg("accent", APP_NAME)) + theme.fg("dim", ` v${host.version}`);
	const model = host.session.state.model?.id ?? "no model";
	const lineOne = `${logo} · ${theme.fg("dim", model)} · ${theme.fg("accent", "/help")}`;

	if (host.options.verbose || !host.settingsManager.getQuietStartup()) {
		host.builtInHeader = new Text(lineOne, 1, 0);
		host.headerContainer.addChild(host.builtInHeader);

		if (host.changelogMarkdown) {
			const versionMatch = host.changelogMarkdown.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/);
			const latestVersion = versionMatch ? versionMatch[1] : host.version;
			const condensedText = theme.fg(
				"muted",
				`Updated to v${latestVersion}. Use ${theme.bold("/changelog")} for details.`,
			);
			host.headerContainer.addChild(new Text(condensedText, 1, 0));
		}
	} else {
		host.builtInHeader = new Text(lineOne, 1, 0);
		host.headerContainer.addChild(host.builtInHeader);
		if (host.changelogMarkdown) {
			const versionMatch = host.changelogMarkdown.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/);
			const latestVersion = versionMatch ? versionMatch[1] : host.version;
			const condensedText = theme.fg(
				"muted",
				`Updated to v${latestVersion}. Use ${theme.bold("/changelog")} for details.`,
			);
			host.headerContainer.addChild(new Text(condensedText, 1, 0));
		}
	}
}

export function dismissStartupHeader(host: InteractiveModeDelegateHost): void {
	if (host.startupHeaderDismissed) return;
	host.startupHeaderDismissed = true;
	host.headerContainer.clear();
	host.builtInHeader = new Text("", 0, 0);
	host.headerContainer.addChild(host.builtInHeader);
	host.ui.requestRender();
}

export function updateTerminalTitle(host: InteractiveModeDelegateHost): void {
	const cwdBasename = path.basename(process.cwd());
	const sessionName = host.sessionManager.getSessionName();
	if (sessionName) {
		host.ui.terminal.setTitle(`π - ${sessionName} - ${cwdBasename}`);
	} else {
		host.ui.terminal.setTitle(`π - ${cwdBasename}`);
	}
}

export { showNewVersionNotification } from "./interactive-ui-messaging.js";
