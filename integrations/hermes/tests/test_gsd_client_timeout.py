"""Unit tests for MCP stdio read timeouts."""

from __future__ import annotations

import subprocess
import sys

import pytest

from open_gsd_hermes.config import GsdConfig
from open_gsd_hermes.gsd_client import GsdMcpClient, McpProtocolError


def test_read_message_times_out_waiting_for_headers() -> None:
    client = GsdMcpClient(GsdConfig(mcp_read_timeout_seconds=0.05))
    proc = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(10)"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    client._proc = proc

    try:
        with pytest.raises(McpProtocolError, match="timed out"):
            client._read_message()
        assert client._proc is None
        assert proc.poll() is not None
    finally:
        proc.kill()


def test_read_message_times_out_waiting_for_body() -> None:
    client = GsdMcpClient(GsdConfig(mcp_read_timeout_seconds=0.05))
    proc = subprocess.Popen(
        [
            sys.executable,
            "-c",
            (
                "import sys, time; "
                "sys.stdout.buffer.write(b'Content-Length: 2\\r\\n\\r\\n{'); "
                "sys.stdout.flush(); "
                "time.sleep(10)"
            ),
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    client._proc = proc

    try:
        with pytest.raises(McpProtocolError, match="timed out"):
            client._read_message()
        assert client._proc is None
        assert proc.poll() is not None
    finally:
        proc.kill()
