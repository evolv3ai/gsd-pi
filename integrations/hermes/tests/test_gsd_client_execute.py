"""Unit tests for MCP-backed GSD execution."""

from __future__ import annotations

from unittest.mock import patch

from open_gsd_hermes.config import GsdConfig
from open_gsd_hermes.gsd_client import GsdMcpClient, GsdVersionError


def test_execute_falls_back_to_mcp_when_cli_version_is_unsupported() -> None:
    client = GsdMcpClient(GsdConfig())

    with patch.object(client, "_call_tool") as call_tool:
        call_tool.side_effect = [
            GsdVersionError("old gsd"),
            {"sessionId": "session-1"},
        ]

        result = client.execute("/tmp/p")

    assert result == {"sessionId": "session-1"}
    assert call_tool.call_args_list[0].args == (
        "gsd_execute",
        {"projectDir": "/tmp/p", "command": "/gsd auto"},
    )
    assert call_tool.call_args_list[0].kwargs == {"project_dir": "/tmp/p"}
    assert call_tool.call_args_list[1].args == (
        "gsd_execute",
        {"projectDir": "/tmp/p", "command": "/gsd auto"},
    )
    assert call_tool.call_args_list[1].kwargs == {
        "check_version": False,
        "project_dir": "/tmp/p",
    }
