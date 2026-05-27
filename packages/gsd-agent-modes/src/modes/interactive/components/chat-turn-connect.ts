// Project/App: gsd-pi
// File Purpose: Detect and apply connected transcript rails between chat turns.

import { Spacer } from "@gsd/pi-tui";
import { AssistantMessageComponent } from "./assistant-message.js";
import { ToolExecutionComponent, ToolPhaseSummaryComponent } from "./tool-execution.js";
import { UserMessageComponent } from "./user-message.js";

type ChatTurnComponent = UserMessageComponent | AssistantMessageComponent;

function isChatTurnComponent(child: unknown): child is ChatTurnComponent {
	return child instanceof UserMessageComponent || child instanceof AssistantMessageComponent;
}

export function chatTurnFollowsUser(children: readonly unknown[]): boolean {
	for (let i = children.length - 1; i >= 0; i--) {
		const child = children[i];
		if (child instanceof Spacer) continue;
		if (child instanceof ToolExecutionComponent || child instanceof ToolPhaseSummaryComponent) continue;
		return child instanceof UserMessageComponent;
	}
	return false;
}

export function chatTurnFollowsAssistant(children: readonly unknown[]): boolean {
	for (let i = children.length - 1; i >= 0; i--) {
		const child = children[i];
		if (child instanceof Spacer) continue;
		return child instanceof AssistantMessageComponent;
	}
	return false;
}

/** Recompute connected-rail flags for every user/assistant turn in the chat container. */
export function reconcileChatTurnConnections(children: readonly unknown[]): void {
	for (const child of children) {
		if (child instanceof UserMessageComponent) {
			child.setContinuesToAssistant(false);
			child.setFollowsAssistant(false);
		} else if (child instanceof AssistantMessageComponent) {
			child.setContinuesToUser(false);
			child.setConnectedToUser(false);
		}
	}

	let previousTurn: ChatTurnComponent | undefined;
	for (const child of children) {
		if (child instanceof Spacer) continue;
		if (!isChatTurnComponent(child)) {
			previousTurn = undefined;
			continue;
		}

		if (previousTurn instanceof UserMessageComponent && child instanceof AssistantMessageComponent) {
			previousTurn.setContinuesToAssistant(true);
			child.setConnectedToUser(true);
		} else if (previousTurn instanceof AssistantMessageComponent && child instanceof UserMessageComponent) {
			previousTurn.setContinuesToUser(true);
			child.setFollowsAssistant(true);
		}

		previousTurn = child;
	}
}

export function connectAssistantToPrecedingUser(children: readonly unknown[]): boolean {
	return chatTurnFollowsUser(children);
}
