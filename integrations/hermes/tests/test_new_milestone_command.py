"""Tests for /gsd new-milestone command routing and the cross-command guards.

Covers the issue #1162 design:
- _cmd_new_milestone: input parsing (bare text, --file, empty, --auto rejected),
  co-run guard (reject if auto RUNNING/BLOCKED), spawn + ack, help text.
- _cmd_auto: symmetric co-run guard (reject if milestone run active).
- _cmd_cancel: routes to cancel_milestone() when a milestone subprocess is active.
- _cmd_reply: routes planning-blocker replies to client stdin when milestone
  subprocess is active with a pending blocker.

Async handlers are driven with asyncio.run, matching the convention in
test_register.py.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from open_gsd_hermes.commands import GsdCommandRouter
from open_gsd_hermes.config import GsdConfig
from open_gsd_hermes.supervisor import SupervisorContext, SupervisorState
from open_gsd_hermes.types import BindingContext


def _make_router(
    *,
    project_dir: str | None = "/proj",
    supervisor_state: SupervisorState = SupervisorState.IDLE,
    milestone_active: bool = False,
    milestone_blocker_id: str | None = None,
) -> tuple[GsdCommandRouter, MagicMock]:
    """Build a router with a MagicMock client + bind store for isolated testing."""
    config = GsdConfig(default_project=project_dir)
    client = MagicMock()
    client.milestone_active.return_value = milestone_active
    client.milestone_session_id.return_value = "S-1" if milestone_active else None
    client.milestone_pending_blocker_id.return_value = milestone_blocker_id
    bind_store = MagicMock()
    supervisor = MagicMock()
    notifications = MagicMock()

    sup_ctx_holder: dict[str, SupervisorContext] = {
        "ctx": SupervisorContext(
            session_id=None,
            project_dir=project_dir,
            state=supervisor_state,
        )
    }

    def get_session_key() -> str:
        return "agent:main:cli:direct:local"

    def get_binding_ctx() -> BindingContext:
        return BindingContext(cwd=project_dir)

    def get_supervisor_ctx() -> SupervisorContext:
        return sup_ctx_holder["ctx"]

    def set_supervisor_ctx(ctx: SupervisorContext) -> None:
        sup_ctx_holder["ctx"] = ctx

    def get_platform_channel() -> tuple[str | None, str | None]:
        return "cli", "local"

    router = GsdCommandRouter(
        config,
        client,
        bind_store,
        supervisor,
        get_session_key,
        get_binding_ctx,
        get_supervisor_ctx,
        set_supervisor_ctx,
        get_platform_channel,
        notifications,
    )
    return router, client


@pytest.fixture
def project(tmp_path: Path) -> Path:
    """A directory that looks like a GSD project (.gsd/ present)."""
    (tmp_path / ".gsd").mkdir()
    return tmp_path


def run(router: GsdCommandRouter, args: str) -> str:
    return asyncio.run(router.handle(args))


# ---------------------------------------------------------------------------
# _cmd_new_milestone — input parsing & usage
# ---------------------------------------------------------------------------


def test_new_milestone_bare_text_passes_context_text(project: Path) -> None:
    router, client = _make_router(project_dir=str(project))
    result = run(router, "new-milestone Build a REST API with auth")
    client.create_milestone.assert_called_once()
    kwargs = client.create_milestone.call_args.kwargs
    assert kwargs.get("context_text") == "Build a REST API with auth"
    assert kwargs.get("context_file") is None
    assert "started" in result.lower() or "S-1" in result


def test_new_milestone_terminal_callback_clears_local_session_id(
    project: Path,
) -> None:
    router, client = _make_router(project_dir=str(project))
    client.create_milestone.return_value = "milestone-4242"

    run(router, "new-milestone Build a REST API with auth")
    ctx = router._get_supervisor_ctx()  # type: ignore[attr-defined]
    ctx.pending_blocker_id = "blk-1"
    assert ctx.session_id == "milestone-4242"

    on_terminal = client.create_milestone.call_args.kwargs["on_terminal"]
    on_terminal("complete")

    ctx = router._get_supervisor_ctx()  # type: ignore[attr-defined]
    assert ctx.state == SupervisorState.COMPLETE
    assert ctx.session_id is None
    assert ctx.pending_blocker_id is None
    assert ctx.notified_terminal is True

    result = run(router, "reply stale response")
    client.resolve_blocker.assert_not_called()
    assert "no active" in result.lower()


def test_new_milestone_file_flag_passes_context_file(project: Path) -> None:
    router, client = _make_router(project_dir=str(project))
    spec = project / "spec.md"
    spec.write_text("milestone spec", encoding="utf-8")
    run(router, f"new-milestone --file {spec}")
    kwargs = client.create_milestone.call_args.kwargs
    assert kwargs.get("context_file") == str(spec)
    assert kwargs.get("context_text") is None


def test_new_milestone_file_flag_resolves_relative_path_from_project(
    project: Path,
) -> None:
    router, client = _make_router(project_dir=str(project))
    spec = project / "spec.md"
    spec.write_text("milestone spec", encoding="utf-8")
    run(router, "new-milestone --file spec.md")
    kwargs = client.create_milestone.call_args.kwargs
    assert kwargs.get("context_file") == str(spec)
    assert kwargs.get("context_text") is None


def test_new_milestone_file_flag_rejects_missing_file(project: Path) -> None:
    router, client = _make_router(project_dir=str(project))
    result = run(router, "new-milestone --file missing.md")
    assert "not found" in result.lower()
    client.create_milestone.assert_not_called()


def test_new_milestone_empty_returns_usage(project: Path) -> None:
    router, client = _make_router(project_dir=str(project))
    result = run(router, "new-milestone")
    assert "usage" in result.lower()
    client.create_milestone.assert_not_called()


def test_new_milestone_rejects_auto_flag(project: Path) -> None:
    """--auto chaining is out of scope; execution stays with /gsd auto."""
    router, client = _make_router(project_dir=str(project))
    result = run(router, "new-milestone --auto some spec")
    assert "auto" in result.lower()
    client.create_milestone.assert_not_called()


# ---------------------------------------------------------------------------
# Co-run guards (Q2 + Q9 symmetry)
# ---------------------------------------------------------------------------


def test_new_milestone_rejects_when_auto_running(project: Path) -> None:
    """Co-run guard: refuse if an auto session is RUNNING or BLOCKED."""
    router, client = _make_router(
        project_dir=str(project),
        supervisor_state=SupervisorState.RUNNING,
    )
    result = run(router, "new-milestone some spec")
    assert "cancel" in result.lower() or "running" in result.lower()
    client.create_milestone.assert_not_called()


def test_new_milestone_rejects_when_auto_blocked(project: Path) -> None:
    router, client = _make_router(
        project_dir=str(project),
        supervisor_state=SupervisorState.BLOCKED,
    )
    result = run(router, "new-milestone some spec")
    assert "cancel" in result.lower() or "running" in result.lower()
    client.create_milestone.assert_not_called()


def test_new_milestone_prioritizes_milestone_guard_over_auto_state(
    project: Path,
) -> None:
    """A duplicate milestone command should report the milestone guard."""
    router, client = _make_router(
        project_dir=str(project),
        supervisor_state=SupervisorState.RUNNING,
        milestone_active=True,
    )
    result = run(router, "new-milestone some spec")
    assert "milestone creation is in progress" in result.lower()
    assert "auto is running" not in result.lower()
    client.create_milestone.assert_not_called()


def test_new_milestone_allows_when_auto_complete(project: Path) -> None:
    """A terminal auto state does not block milestone creation."""
    router, client = _make_router(
        project_dir=str(project),
        supervisor_state=SupervisorState.COMPLETE,
    )
    run(router, "new-milestone some spec")
    client.create_milestone.assert_called_once()


def test_auto_rejects_when_milestone_active(project: Path) -> None:
    """Symmetric guard: /gsd auto refuses if a milestone run is in progress."""
    router, client = _make_router(
        project_dir=str(project),
        milestone_active=True,
    )
    result = run(router, "auto")
    assert "cancel" in result.lower() or "milestone" in result.lower()
    client.execute.assert_not_called()


# ---------------------------------------------------------------------------
# _cmd_cancel — milestone branch
# ---------------------------------------------------------------------------


def test_cancel_routes_to_cancel_milestone_when_milestone_active(
    project: Path,
) -> None:
    router, client = _make_router(
        project_dir=str(project),
        milestone_active=True,
    )
    run(router, "cancel")
    client.cancel_milestone.assert_called_once()


def test_cancel_routes_to_mcp_cancel_when_only_auto_active(project: Path) -> None:
    """When no milestone proc is active, cancel falls back to the MCP path."""
    router, client = _make_router(
        project_dir=str(project),
        supervisor_state=SupervisorState.RUNNING,
    )
    # Give the auto session an id so the MCP cancel-by-session path is taken
    run(router, "cancel")
    client.cancel_milestone.assert_not_called()
    assert client.cancel.called or client.cancel_by_project.called


# ---------------------------------------------------------------------------
# _cmd_reply — milestone-blocker branch
# ---------------------------------------------------------------------------


def test_reply_routes_to_milestone_blocker_when_milestone_pending(
    project: Path,
) -> None:
    router, client = _make_router(
        project_dir=str(project),
        milestone_active=True,
        milestone_blocker_id="blk-9",
    )
    result = run(router, "reply use option B")
    client.respond_to_milestone_blocker.assert_called_once_with("use option B")
    assert "sent" in result.lower()


def test_reply_does_not_fall_through_to_mcp_when_milestone_active_no_blocker(
    project: Path,
) -> None:
    """Active milestone without a pending blocker must not hit MCP resolve_blocker."""
    router, client = _make_router(
        project_dir=str(project),
        milestone_active=True,
        milestone_blocker_id=None,
    )
    router._get_supervisor_ctx().session_id = "milestone-1"  # type: ignore[attr-defined]
    result = run(router, "reply some answer")
    client.respond_to_milestone_blocker.assert_not_called()
    client.resolve_blocker.assert_not_called()
    assert "no pending blocker" in result.lower()


def test_reply_falls_back_to_mcp_when_no_milestone(project: Path) -> None:
    """No milestone proc → existing MCP resolve_blocker path (needs a session)."""
    router, client = _make_router(
        project_dir=str(project),
        supervisor_state=SupervisorState.BLOCKED,
    )
    # set a session id so the existing reply path doesn't short-circuit
    router._get_supervisor_ctx().session_id = "auto-1"  # type: ignore[attr-defined]
    run(router, "reply some answer")
    client.respond_to_milestone_blocker.assert_not_called()
    client.resolve_blocker.assert_called_once()
