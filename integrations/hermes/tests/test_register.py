"""Registration integration tests."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Callable
from unittest.mock import MagicMock

import open_gsd_hermes
from open_gsd_hermes.config import GsdConfig
from open_gsd_hermes.types import ProgressSnapshot


class FakeContext:
    def __init__(self) -> None:
        self.commands: dict[str, Callable[..., Any]] = {}
        self.hooks: dict[str, Callable[..., Any]] = {}

    def register_command(self, name: str, handler: Callable[..., Any]) -> None:
        self.commands[name] = handler

    def register_hook(self, name: str, handler: Callable[..., Any]) -> None:
        self.hooks[name] = handler

    def register_memory_provider(self, _provider: Any) -> None:
        pass

    def dispatch_tool(self, _name: str, _arguments: dict[str, Any]) -> None:
        pass


def test_pre_llm_call_uses_bound_session_project(tmp_path: Path, monkeypatch) -> None:
    default_project = tmp_path / "default"
    bound_project = tmp_path / "bound"
    (default_project / ".gsd").mkdir(parents=True)
    (bound_project / ".gsd").mkdir(parents=True)
    client = MagicMock()
    client.progress.return_value = ProgressSnapshot(phase="execute")
    ctx = FakeContext()

    monkeypatch.setenv("HERMES_SESSION_KEY", "agent:main:cli:direct:local")
    monkeypatch.setattr(
        open_gsd_hermes,
        "load_config",
        lambda: GsdConfig(default_project=str(default_project)),
    )
    monkeypatch.setattr(open_gsd_hermes, "GsdMcpClient", lambda _config: client)

    open_gsd_hermes.register(ctx)
    bind_result = asyncio.run(ctx.commands["gsd"](f"bind {bound_project}"))
    hook_result = ctx.hooks["pre_llm_call"]()

    assert bind_result == f"Bound to `{bound_project.resolve()}`"
    assert hook_result["context"].startswith("## GSD Project Snapshot")
    client.progress.assert_called_once_with(str(bound_project.resolve()))
