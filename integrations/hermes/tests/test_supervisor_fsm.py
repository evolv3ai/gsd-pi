"""Supervisor FSM transition tests with mock MCP."""

from __future__ import annotations

import asyncio
import threading
from unittest.mock import MagicMock

from open_gsd_hermes.binding import SessionBindStore
from open_gsd_hermes.commands import GsdCommandRouter
from open_gsd_hermes.config import GsdConfig
from open_gsd_hermes.notifications import NotificationService
from open_gsd_hermes.supervisor import SupervisorContext, SupervisorFsm, SupervisorState
from open_gsd_hermes.types import (
    BindingContext,
    DeliveryTarget,
    ProgressSnapshot,
    SessionStatus,
)


class MockClient:
    def __init__(self) -> None:
        self.status_calls = 0
        self._status = SessionStatus(status="running")
        self._progress = ProgressSnapshot(phase="execute")
        self.invalidated: list[str | None] = []

    def status(self, _session_id: str) -> SessionStatus:
        self.status_calls += 1
        return self._status

    def progress(self, _project_dir: str) -> ProgressSnapshot:
        return self._progress

    def invalidate_cache(self, _project_dir: str | None = None) -> None:
        self.invalidated.append(_project_dir)


class MockSupervisor:
    def __init__(self) -> None:
        self.started = False
        self.stopped = False
        self.calls: list[str] = []

    def start(self) -> None:
        self.started = True
        self.calls.append("start")

    def stop(self) -> None:
        self.stopped = True
        self.calls.append("stop")


def test_supervisor_restart_keeps_abandoned_thread_stop_event_set() -> None:
    fsm = SupervisorFsm(
        GsdConfig(poll_interval_seconds=1),
        MagicMock(),
        MagicMock(),
        lambda: SupervisorContext(),
        lambda c: None,
    )
    abandoned_stop = fsm._stop
    abandoned_stop.set()
    fsm._thread = None

    fsm.start()

    try:
        assert abandoned_stop.is_set()
        assert fsm._stop is not abandoned_stop
    finally:
        fsm.stop()


def test_bind_rejects_invalid_path_instead_of_falling_back_to_default(tmp_path) -> None:
    project_dir = tmp_path / "project"
    (project_dir / ".gsd").mkdir(parents=True)
    bind_store = SessionBindStore()
    client = MagicMock()

    router = GsdCommandRouter(
        GsdConfig(default_project=str(project_dir)),
        client,
        bind_store,
        MockSupervisor(),  # type: ignore[arg-type]
        lambda: "session-key",
        lambda: BindingContext(),
        lambda: SupervisorContext(),
        lambda c: None,
        lambda: (None, None),
    )

    result = asyncio.run(router._cmd_bind([str(tmp_path / "missing")]))

    assert "is not a GSD project" in result
    assert bind_store.get("session-key") is None
    client.invalidate_cache.assert_not_called()


def test_auto_resets_session_specific_supervisor_context(tmp_path) -> None:
    project_dir = tmp_path / "project"
    (project_dir / ".gsd").mkdir(parents=True)
    ctx = SupervisorContext(
        session_id="old-session",
        project_dir="/tmp/old",
        state=SupervisorState.COMPLETE,
        last_progress=ProgressSnapshot(active_task={"id": "old-task"}),
        last_status=SessionStatus(status="complete"),
        pending_blocker_id="old-blocker",
        notified_terminal=True,
    )
    supervisor = MockSupervisor()
    client = MagicMock()
    client.execute.return_value = {"sessionId": "new-session"}

    router = GsdCommandRouter(
        GsdConfig(default_project=str(project_dir)),
        client,
        SessionBindStore(),
        supervisor,  # type: ignore[arg-type]
        lambda: "session-key",
        lambda: BindingContext(),
        lambda: ctx,
        lambda c: None,
        lambda: (None, None),
    )

    result = asyncio.run(router._cmd_auto([]))

    assert result == "Started GSD auto mode (session `new-session`)"
    assert supervisor.started
    assert supervisor.calls == ["stop", "start"]
    assert ctx.session_id == "new-session"
    assert ctx.project_dir == str(project_dir)
    assert ctx.state == SupervisorState.RUNNING
    assert ctx.last_progress is None
    assert ctx.last_status is None
    assert ctx.pending_blocker_id is None
    assert not ctx.notified_terminal


def test_supervisor_detects_blocker() -> None:
    ctx = SupervisorContext(
        session_id="s1",
        project_dir="/tmp/p",
        state=SupervisorState.RUNNING,
    )
    client = MockClient()
    client._status = SessionStatus(
        status="running",
        pending_blocker={"id": "b1", "question": "Approve deploy?"},
    )
    sent: list[str] = []

    def dispatch(_name: str, args: dict) -> None:
        sent.append(args.get("text", ""))

    target = DeliveryTarget("slack", "channel", "C123")
    notifications = NotificationService(
        MagicMock(),
        GsdConfig(),
        lambda: target,
        dispatch=dispatch,
    )
    fsm = SupervisorFsm(
        GsdConfig(),
        client,  # type: ignore[arg-type]
        notifications,
        lambda: ctx,
        lambda c: None,
    )
    fsm._tick()
    assert ctx.state == SupervisorState.BLOCKED
    assert any("blocker" in t.lower() or "Approve" in t for t in sent)


def test_supervisor_terminal_tick_updates_progress_before_stopping() -> None:
    ctx = SupervisorContext(
        session_id="s1",
        project_dir="/tmp/p",
        state=SupervisorState.RUNNING,
        last_progress=ProgressSnapshot(
            active_task={"id": "old-task"},
            phase="execute",
        ),
    )
    client = MockClient()
    client._status = SessionStatus(status="complete")
    client._progress = ProgressSnapshot(
        active_task={"id": "new-task"},
        phase="complete",
    )
    stored: list[SupervisorContext] = []
    sent: list[str] = []

    def dispatch(_name: str, args: dict) -> None:
        sent.append(args.get("text", ""))

    target = DeliveryTarget("slack", "channel", "C123")
    notifications = NotificationService(
        MagicMock(),
        GsdConfig(),
        lambda: target,
        dispatch=dispatch,
    )
    fsm = SupervisorFsm(
        GsdConfig(),
        client,  # type: ignore[arg-type]
        notifications,
        lambda: ctx,
        stored.append,
    )
    fsm._thread = threading.current_thread()

    fsm._tick()

    assert fsm._stop.is_set()
    assert ctx.notified_terminal
    assert ctx.last_progress == client._progress
    assert stored == [ctx]
    assert any("finished" in t for t in sent)
    assert any("new-task" in t for t in sent)
    assert sent == [
        "📋 GSD: task → new-task",
        "✅ GSD auto mode finished.",
    ]


def test_supervisor_terminal_status_takes_precedence_over_pending_blocker() -> None:
    ctx = SupervisorContext(
        session_id="s1",
        project_dir="/tmp/p",
        state=SupervisorState.BLOCKED,
    )
    client = MockClient()
    client._status = SessionStatus(
        status="Completed",
        pending_blocker={"id": "b1", "question": "Approve deploy?"},
    )
    stored: list[SupervisorContext] = []
    sent: list[str] = []

    def dispatch(_name: str, args: dict) -> None:
        sent.append(args.get("text", ""))

    notifications = NotificationService(
        MagicMock(),
        GsdConfig(),
        lambda: DeliveryTarget("slack", "channel", "C123"),
        dispatch=dispatch,
    )
    fsm = SupervisorFsm(
        GsdConfig(),
        client,  # type: ignore[arg-type]
        notifications,
        lambda: ctx,
        stored.append,
    )
    fsm._thread = threading.current_thread()

    fsm._tick()

    assert ctx.state == SupervisorState.COMPLETE
    assert ctx.notified_terminal
    assert fsm._stop.is_set()
    assert stored == [ctx]
    assert sent == ["✅ GSD auto mode finished."]


def test_supervisor_keeps_cache_when_progress_unchanged() -> None:
    ctx = SupervisorContext(
        session_id="s1",
        project_dir="/tmp/p",
        state=SupervisorState.RUNNING,
        last_progress=ProgressSnapshot(
            active_task={"id": "same-task"},
            phase="execute",
        ),
    )
    client = MockClient()
    client._status = SessionStatus(status="running")
    client._progress = ProgressSnapshot(
        active_task={"id": "same-task"},
        phase="execute",
    )

    notifications = NotificationService(
        MagicMock(),
        GsdConfig(),
        lambda: DeliveryTarget("slack", "channel", "C123"),
        dispatch=lambda _name, _args: None,
    )
    fsm = SupervisorFsm(
        GsdConfig(),
        client,  # type: ignore[arg-type]
        notifications,
        lambda: ctx,
        lambda c: None,
    )

    fsm._tick()

    assert client.invalidated == []
