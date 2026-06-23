"""Shared types for the open-gsd-hermes plugin."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Protocol


class PluginContext(Protocol):
    """Minimal Hermes plugin context surface used by this integration."""

    def register_command(self, name: str, handler: Callable[..., Any]) -> None: ...
    def register_hook(self, name: str, handler: Callable[..., Any]) -> None: ...
    def register_memory_provider(self, provider: Any) -> None: ...
    def dispatch_tool(self, name: str, arguments: dict[str, Any]) -> Any: ...


@dataclass
class DeliveryTarget:
    """Gateway delivery target for send_message notifications."""

    platform: str
    chat_type: str
    chat_id: str
    session_key: str = ""

    @classmethod
    def from_session_key(cls, session_key: str) -> DeliveryTarget | None:
        # agent:main:{platform}:{chat_type}:{chat_id}
        parts = session_key.split(":")
        if len(parts) < 5 or parts[0] != "agent" or parts[1] != "main":
            return None
        return cls(
            platform=parts[2],
            chat_type=parts[3],
            chat_id=":".join(parts[4:]),
            session_key=session_key,
        )


@dataclass
class ProgressSnapshot:
    """Structured progress compatible with GSD ProgressResult."""

    active_milestone: dict[str, str] | None = None
    active_slice: dict[str, str] | None = None
    active_task: dict[str, str] | None = None
    phase: str = "unknown"
    milestones: dict[str, int] = field(default_factory=dict)
    slices: dict[str, int] = field(default_factory=dict)
    tasks: dict[str, int] = field(default_factory=dict)
    requirements: dict[str, int] | None = None
    blockers: list[str] = field(default_factory=list)
    next_action: str = ""

    @classmethod
    def from_mcp(cls, data: dict[str, Any]) -> ProgressSnapshot:
        return cls(
            active_milestone=data.get("activeMilestone"),
            active_slice=data.get("activeSlice"),
            active_task=data.get("activeTask"),
            phase=data.get("phase", "unknown"),
            milestones=data.get("milestones") or {},
            slices=data.get("slices") or {},
            tasks=data.get("tasks") or {},
            requirements=data.get("requirements"),
            blockers=list(data.get("blockers") or []),
            next_action=data.get("nextAction", ""),
        )


@dataclass
class SessionStatus:
    """Subset of gsd_status response."""

    status: str
    pending_blocker: dict[str, Any] | None = None
    session_id: str | None = None
    error: str | None = None

    @classmethod
    def from_mcp(cls, data: dict[str, Any]) -> SessionStatus:
        return cls(
            status=data.get("status", "unknown"),
            pending_blocker=data.get("pendingBlocker"),
            session_id=data.get("sessionId"),
            error=data.get("error"),
        )


@dataclass
class BindingContext:
    """Inputs for tiered project binding resolution."""

    slash_path: str | None = None
    session_bind: str | None = None
    platform: str | None = None
    channel_id: str | None = None
    cron_project: str | None = None
    cwd: str | None = None
