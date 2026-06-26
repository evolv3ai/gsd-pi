"""Tests for tiered binding resolver."""

from __future__ import annotations

from pathlib import Path

import pytest

from open_gsd_hermes.binding import (
    BindingError,
    SessionBindStore,
    resolve_explicit_project_dir,
    resolve_project_dir,
)
from open_gsd_hermes.config import GsdConfig
from open_gsd_hermes.types import BindingContext

FIXTURE = Path(__file__).parent / "fixtures" / "minimal-project"


@pytest.fixture
def config() -> GsdConfig:
    return GsdConfig(
        default_project=None,
        bindings={"slack": {"#eng-bot": str(FIXTURE)}},
    )


def test_slash_path_wins_over_channel_binding(
    config: GsdConfig, tmp_path: Path
) -> None:
    other = tmp_path / "other"
    other.mkdir()
    (other / ".gsd").mkdir()
    ctx = BindingContext(
        slash_path=str(other),
        platform="slack",
        channel_id="#eng-bot",
    )
    assert resolve_project_dir(config, ctx) == str(other.resolve())


def test_explicit_project_dir_rejects_invalid_project(tmp_path: Path) -> None:
    with pytest.raises(BindingError):
        resolve_explicit_project_dir(str(tmp_path / "missing"))


def test_session_bind_wins_over_channel_binding(
    config: GsdConfig, tmp_path: Path
) -> None:
    other = tmp_path / "other"
    other.mkdir()
    (other / ".gsd").mkdir()
    store = SessionBindStore()
    store.set("sess-1", str(other))
    ctx = BindingContext(
        session_bind=store.get("sess-1"),
        platform="slack",
        channel_id="#eng-bot",
    )
    assert resolve_project_dir(config, ctx) == str(other.resolve())


def test_session_bind_wins_over_default(config: GsdConfig, tmp_path: Path) -> None:
    other = tmp_path / "other"
    other.mkdir()
    (other / ".gsd").mkdir()
    config.default_project = str(other)
    store = SessionBindStore()
    store.set("sess-1", str(FIXTURE))
    ctx = BindingContext(session_bind=store.get("sess-1"))
    assert resolve_project_dir(config, ctx) == str(FIXTURE.resolve())


def test_channel_binding(config: GsdConfig) -> None:
    ctx = BindingContext(platform="slack", channel_id="#eng-bot")
    assert resolve_project_dir(config, ctx) == str(FIXTURE.resolve())


def test_cron_explicit_over_channel(config: GsdConfig, tmp_path: Path) -> None:
    cron_proj = tmp_path / "cron"
    cron_proj.mkdir()
    (cron_proj / ".gsd").mkdir()
    ctx = BindingContext(
        cron_project=str(cron_proj),
        platform="slack",
        channel_id="#eng-bot",
    )
    assert resolve_project_dir(config, ctx) == str(cron_proj.resolve())


def test_fail_closed(config: GsdConfig) -> None:
    with pytest.raises(BindingError):
        resolve_project_dir(config, BindingContext())


def test_fail_open_returns_none(config: GsdConfig) -> None:
    assert resolve_project_dir(config, BindingContext(), fail_closed=False) is None


def test_cwd_heuristic(config: GsdConfig) -> None:
    ctx = BindingContext(cwd=str(FIXTURE))
    assert resolve_project_dir(config, ctx) == str(FIXTURE.resolve())
