"""Gateway notifications via ctx.dispatch_tool('send_message', ...)."""

from __future__ import annotations

from typing import Any, Callable

from open_gsd_hermes.config import GsdConfig
from open_gsd_hermes.types import DeliveryTarget, PluginContext, SessionStatus


class NotificationService:
    """Format and send supervisor notifications to the gateway."""

    def __init__(
        self,
        ctx: PluginContext,
        config: GsdConfig,
        get_target: Callable[[], DeliveryTarget | None],
        dispatch: Callable[[str, dict[str, Any]], Any] | None = None,
    ) -> None:
        self._ctx = ctx
        self._config = config
        self._get_target = get_target
        self._dispatch = dispatch or ctx.dispatch_tool

    def _should_send(self, kind: str) -> bool:
        level = self._config.notification_level
        if level == "verbose":
            return True
        if level == "quiet":
            return kind in ("blocker", "failure", "complete")
        # normal
        return kind in ("blocker", "transition", "failure", "complete")

    def send(self, text: str, *, kind: str = "transition") -> bool:
        if not self._should_send(kind):
            return False
        target = self._get_target()
        if target is None:
            return False
        payload = {
            "platform": target.platform,
            "chat_type": target.chat_type,
            "chat_id": target.chat_id,
            "text": text,
        }
        try:
            self._dispatch("send_message", payload)
            return True
        except Exception:
            return False

    def notify_blocker(self, status: SessionStatus) -> None:
        blocker = status.pending_blocker or {}
        q = (
            blocker.get("question")
            or blocker.get("prompt")
            or blocker.get("message")
            or "Action required"
        )
        self.send(f"🚧 GSD blocker: {q}\nReply with `/gsd reply <your answer>`", kind="blocker")

    def notify_transition(self, message: str) -> None:
        self.send(f"📋 GSD: {message}", kind="transition")

    def notify_terminal(self, status: str, error: str | None = None) -> None:
        normalized_status = status.lower()
        if normalized_status in ("complete", "completed", "done"):
            self.send("✅ GSD auto mode finished.", kind="complete")
        elif normalized_status == "cancelled":
            self.send("⏹ GSD session cancelled.", kind="complete")
        else:
            msg = f"❌ GSD session {status}"
            if error:
                msg += f": {error}"
            self.send(msg, kind="failure")
