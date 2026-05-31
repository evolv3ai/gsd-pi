// Project/App: gsd-pi
// File Purpose: OAuth provider selector for login and logout actions.

import type { OAuthProviderInterface } from "@gsd/pi-ai";
import { getOAuthProviders } from "@gsd/pi-ai/oauth";
import { Container, getEditorKeybindings, Spacer, TruncatedText } from "@gsd/pi-tui";
import type { AuthStorage } from "@gsd/pi-coding-agent/core/auth-storage.js";
import { theme } from "@gsd/pi-coding-agent/theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { selectorFooter } from "./keybinding-hints.js";
import { renderCursor } from "./tree-render-utils.js";

export type AuthSelectorProvider = Pick<OAuthProviderInterface, "id" | "name" | "usesCallbackServer"> & {
	authType?: "oauth" | "api_key" | "external_cli";
	statusLabel?: string;
};

/**
 * Component that renders an OAuth provider selector
 */
export class OAuthSelectorComponent extends Container {
	private listContainer: Container;
	private allProviders: AuthSelectorProvider[] = [];
	private selectedIndex: number = 0;
	private mode: "login" | "logout";
	private authStorage: AuthStorage;
	private onSelectCallback: (providerId: string) => void;
	private onCancelCallback: () => void;

	constructor(
		mode: "login" | "logout",
		authStorage: AuthStorage,
		onSelect: (providerId: string) => void,
		onCancel: () => void,
		providers?: AuthSelectorProvider[],
	) {
		super();

		this.mode = mode;
		this.authStorage = authStorage;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		// Load all OAuth providers
		this.loadProviders(providers);

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Add title
		const title = mode === "login" ? "Select provider to login:" : "Select provider to logout:";
		this.addChild(new TruncatedText(theme.bold(title)));
		this.addChild(new Spacer(1));

		// Create list container
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));
		this.addChild(new TruncatedText(selectorFooter(), 1, 0));
		this.addChild(new Spacer(1));

		// Add bottom border
		this.addChild(new DynamicBorder());

		// Initial render
		this.updateList();
	}

	private loadProviders(providers?: AuthSelectorProvider[]): void {
		this.allProviders = providers ?? getOAuthProviders();
	}

	private updateList(): void {
		this.listContainer.clear();

		for (let i = 0; i < this.allProviders.length; i++) {
			const provider = this.allProviders[i];
			if (!provider) continue;

			const isSelected = i === this.selectedIndex;

			const credentials = this.authStorage.get(provider.id);
			const isLoggedIn = credentials?.type === "oauth";
			const statusIndicator = provider.statusLabel
				? theme.fg("success", ` ${provider.statusLabel}`)
				: isLoggedIn
					? theme.fg("success", " ✓ logged in")
					: "";

			let line = "";
			if (isSelected) {
				const text = theme.fg("accent", provider.name);
				line = renderCursor(true) + text + statusIndicator;
			} else {
				const text = renderCursor(false) + provider.name;
				line = text + statusIndicator;
			}

			this.listContainer.addChild(new TruncatedText(line, 0, 0));
		}

		// Show "no providers" if empty
		if (this.allProviders.length === 0) {
			const message =
				this.mode === "login" ? "No OAuth providers available" : "No OAuth providers logged in. Use /login first.";
			this.listContainer.addChild(new TruncatedText(theme.fg("muted", `  ${message}`), 0, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = getEditorKeybindings();
		// Up arrow (wrap)
		if (kb.matches(keyData, "selectUp")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.allProviders.length - 1 : this.selectedIndex - 1;
			this.updateList();
		}
		// Down arrow (wrap)
		else if (kb.matches(keyData, "selectDown")) {
			this.selectedIndex = this.selectedIndex === this.allProviders.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
		}
		// Enter
		else if (kb.matches(keyData, "selectConfirm")) {
			const selectedProvider = this.allProviders[this.selectedIndex];
			if (selectedProvider) {
				this.onSelectCallback(selectedProvider.id);
			}
		}
		// Escape or Ctrl+C
		else if (kb.matches(keyData, "selectCancel")) {
			this.onCancelCallback();
		}
	}
}
