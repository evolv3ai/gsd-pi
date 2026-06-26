// Project/App: gsd-pi
// File Purpose: Legacy hook for connected transcript rails (Variant B — no longer applied).

/** Plain Variant A transcript does not use connected rails. */
export function chatTurnFollowsUser(_children: readonly unknown[]): boolean {
	return false;
}

/** No-op — plain transcript does not use connected rails. */
export function reconcileChatTurnConnections(_children: readonly unknown[]): void {}
