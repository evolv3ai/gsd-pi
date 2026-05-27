"""Cron integration — gsd headless auto --json with explicit project_dir."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from open_gsd_hermes.config import GsdConfig, load_config
from open_gsd_hermes.credentials import CredentialPassthrough


@dataclass
class CronResult:
    exit_code: int
    output: dict[str, Any] | str
    project_dir: str


def run_headless_auto(
    project_dir: str,
    config: GsdConfig | None = None,
    *,
    timeout_seconds: int = 3600,
    hermes_creds: dict[str, str] | None = None,
) -> CronResult:
    """Run `gsd headless auto --json` for scheduled Hermes cron jobs."""
    cfg = config or load_config()
    project = str(Path(project_dir).expanduser().resolve())
    creds = CredentialPassthrough(cfg.credential_source, hermes_creds)
    env = creds.apply()
    cmd = [
        cfg.cli_path,
        "headless",
        "auto",
        "--json",
        "--timeout",
        str(timeout_seconds * 1000),
    ]
    result = subprocess.run(
        cmd,
        cwd=project,
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout_seconds + 60,
    )
    output: dict[str, Any] | str
    if result.stdout.strip():
        try:
            output = json.loads(result.stdout.strip().splitlines()[-1])
        except json.JSONDecodeError:
            output = result.stdout
    else:
        output = result.stderr or ""
    return CronResult(
        exit_code=result.returncode,
        output=output,
        project_dir=project,
    )


def main(argv: list[str] | None = None) -> int:
    """CLI entry: hermes-gsd-cron <project_dir> [--timeout N]"""
    args = argv if argv is not None else sys.argv[1:]
    if not args:
        print("Usage: hermes-gsd-cron <project_dir> [--timeout SECONDS]", file=sys.stderr)
        return 1
    project_dir = args[0]
    timeout = 3600
    if "--timeout" in args:
        idx = args.index("--timeout")
        if idx + 1 < len(args):
            timeout = int(args[idx + 1])
    cfg = load_config()
    cron_project = os.environ.get("GSD_CRON_PROJECT", project_dir)
    res = run_headless_auto(cron_project, cfg, timeout_seconds=timeout)
    print(json.dumps({"exit_code": res.exit_code, "project_dir": res.project_dir, "output": res.output}))
    return res.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
