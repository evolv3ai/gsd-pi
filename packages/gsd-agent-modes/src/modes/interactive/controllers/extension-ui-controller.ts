import type { ExtensionUIContext } from "@gsd/pi-coding-agent/core/extensions/index.js";

import { Theme, getAvailableThemesWithPaths, getThemeByName, setTheme, setThemeInstance, theme } from "@gsd/pi-coding-agent/theme/theme.js";
import { appKey } from "../components/keybinding-hints.js";
import { startActivityIndicator, stopActivityIndicator } from "./chat-controller.js";

export function createExtensionUIContext(host: any): ExtensionUIContext {
	return {
		select: (title, options, opts) => host.showExtensionSelector(title, options, opts),
		confirm: (title, message, opts) => host.showExtensionConfirm(title, message, opts),
		input: (title, placeholder, opts) => host.showExtensionInput(title, placeholder, opts),
		notify: (message, type) => host.showExtensionNotify(message, type),
		onTerminalInput: (handler) => host.addExtensionTerminalInputListener(handler),
		setStatus: (key, text) => host.setExtensionStatus(key, text),
		setGsdProgress: (state, dispose) => host.setGsdProgress(state, dispose),
		setWorkingMessage: (message) => {
			if (message === null || message === undefined) {
				host.pendingWorkingMessage = null;
				if (host.loadingAnimation) {
					host.loadingAnimation.stop();
					host.loadingAnimation = undefined;
					host.statusContainer.clear();
				}
				// GSD auto-mode suppresses the default loader but the turn is still
				// in flight — keep a compact pulse until agent_end.
				if (host.session?.isStreaming) {
					const phase = host.gsdProgressState?.phase as string | undefined;
					startActivityIndicator(host, phase);
				} else {
					stopActivityIndicator(host);
				}
				host.ui.requestRender();
				return;
			}
			if (host.loadingAnimation) {
				if (message) {
					host.loadingAnimation.setMessage(message);
				} else {
					host.loadingAnimation.setMessage(`${host.defaultWorkingMessage} (${appKey(host.keybindings, "interrupt")} to interrupt)`);
				}
			} else {
				host.pendingWorkingMessage = message;
			}
		},
		setWorkingVisible: (visible) => host.setWorkingVisible?.(visible),
		setWorkingIndicator: (options) => host.setWorkingIndicator?.(options),
		setHiddenThinkingLabel: (label) => host.setHiddenThinkingLabel?.(label),
		addAutocompleteProvider: (factory) => host.addAutocompleteProvider?.(factory),
		getEditorComponent: () => host.getCustomEditorComponent?.(),
		setWidget: (key, content, options) => host.setExtensionWidget(key, content, options),
		setFooter: (factory) => host.setExtensionFooter(factory),
		setHeader: (factory) => host.setExtensionHeader(factory),
		setTitle: (title) => host.ui.terminal.setTitle(title),
		custom: (factory, options) => host.showExtensionCustom(factory, options),
		pasteToEditor: (text) => host.editor.handleInput(`\x1b[200~${text}\x1b[201~`),
		setEditorText: (text) => host.editor.setText(text),
		getEditorText: () => host.editor.getText(),
		editor: (title, prefill) => host.showExtensionEditor(title, prefill),
		setEditorComponent: (factory) => host.setCustomEditorComponent(factory),
		get theme() {
			return theme;
		},
		getAllThemes: () => getAvailableThemesWithPaths(),
		getTheme: (name) => getThemeByName(name),
		setTheme: (themeOrName) => {
			if (themeOrName instanceof Theme) {
				setThemeInstance(themeOrName);
				host.ui.requestRender();
				return { success: true };
			}
			const result = setTheme(themeOrName, true);
			if (result.success) {
				if (host.settingsManager.getTheme() !== themeOrName) {
					host.settingsManager.setTheme(themeOrName);
				}
				host.ui.requestRender();
			}
			return result;
		},
		getToolsExpanded: () => host.toolOutputExpanded,
		setToolsExpanded: (expanded) => host.setToolsExpanded(expanded),
	};
}
