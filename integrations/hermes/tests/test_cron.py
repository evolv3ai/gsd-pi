"""Cron CLI tests."""

from __future__ import annotations

from open_gsd_hermes import cron
from open_gsd_hermes.config import GsdConfig


def test_main_prefers_cli_project_over_gsd_cron_project(monkeypatch, tmp_path) -> None:
    cli_project = tmp_path / "cli-project"
    env_project = tmp_path / "env-project"
    captured: dict[str, object] = {}

    monkeypatch.setenv("GSD_CRON_PROJECT", str(env_project))
    monkeypatch.setattr(cron, "load_config", lambda: GsdConfig())

    def fake_run_headless_auto(
        project_dir: str,
        config: GsdConfig,
        *,
        timeout_seconds: int,
    ) -> cron.CronResult:
        captured["project_dir"] = project_dir
        captured["config"] = config
        captured["timeout_seconds"] = timeout_seconds
        return cron.CronResult(0, {"ok": True}, project_dir)

    monkeypatch.setattr(cron, "run_headless_auto", fake_run_headless_auto)

    result = cron.main([str(cli_project), "--timeout", "7"])

    assert result == 0
    assert captured["project_dir"] == str(cli_project)
    assert captured["timeout_seconds"] == 7
