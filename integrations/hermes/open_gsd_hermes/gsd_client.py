"""Persistent gsd-mcp-server MCP client (stdio JSON-RPC)."""

from __future__ import annotations

import json
import os
import subprocess
import threading
import time
from dataclasses import dataclass, field
from typing import Any

from packaging import version

from open_gsd_hermes.config import GsdConfig
from open_gsd_hermes.types import ProgressSnapshot, SessionStatus


class GsdVersionError(Exception):
    pass


class McpProtocolError(Exception):
    pass


@dataclass
class _CacheEntry:
    value: Any
    expires_at: float


class GsdMcpClient:
    """JSON-RPC client for gsd-mcp-server with TTL cache for read tools."""

    def __init__(self, config: GsdConfig) -> None:
        self._config = config
        self._proc: subprocess.Popen[bytes] | None = None
        self._lock = threading.Lock()
        self._request_id = 0
        self._cache: dict[str, _CacheEntry] = {}
        self._version_checked = False

    def _env(self) -> dict[str, str]:
        env = os.environ.copy()
        env["GSD_CLI_PATH"] = self._config.cli_path
        return env

    def ensure_version(self) -> None:
        if self._version_checked:
            return
        result = subprocess.run(
            [self._config.cli_path, "--version"],
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
        out = (result.stdout or result.stderr or "").strip()
        # gsd --version may print "1.0.2" or "gsd 1.0.2"
        ver_str = out.split()[-1] if out else "0"
        try:
            ver = version.parse(ver_str)
        except version.InvalidVersion as e:
            raise GsdVersionError(f"Could not parse gsd version from: {out!r}") from e
        min_v = version.parse(self._config.gsd_version_min)
        max_v = version.parse(self._config.gsd_version_max)
        if ver < min_v or ver >= max_v:
            raise GsdVersionError(
                f"gsd {ver} not in supported range "
                f">={self._config.gsd_version_min},<{self._config.gsd_version_max}"
            )
        self._version_checked = True

    def _ensure_process(self) -> subprocess.Popen[bytes]:
        if self._proc is not None and self._proc.poll() is None:
            return self._proc
        self._proc = subprocess.Popen(
            [self._config.mcp_server_path],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=self._env(),
        )
        self._initialize()
        return self._proc

    def _send(self, payload: dict[str, Any]) -> None:
        proc = self._ensure_process()
        assert proc.stdin is not None
        body = json.dumps(payload).encode("utf-8")
        header = f"Content-Length: {len(body)}\r\n\r\n".encode("ascii")
        proc.stdin.write(header + body)
        proc.stdin.flush()

    def _read_message(self) -> dict[str, Any]:
        proc = self._ensure_process()
        assert proc.stdout is not None
        headers: dict[str, str] = {}
        while True:
            line = proc.stdout.readline()
            if not line:
                raise McpProtocolError("MCP server closed stdout")
            decoded = line.decode("utf-8").strip()
            if decoded == "":
                break
            key, _, val = decoded.partition(":")
            headers[key.strip().lower()] = val.strip()
        length = int(headers.get("content-length", "0"))
        body = proc.stdout.read(length)
        return json.loads(body.decode("utf-8"))

    def _initialize(self) -> None:
        self._request_id += 1
        self._send(
            {
                "jsonrpc": "2.0",
                "id": self._request_id,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "open-gsd-hermes", "version": "1.2.0"},
                },
            }
        )
        _ = self._read_message()
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def _call_tool(
        self, name: str, arguments: dict[str, Any], *, check_version: bool = True
    ) -> dict[str, Any]:
        with self._lock:
            if check_version:
                self.ensure_version()
            self._request_id += 1
            req_id = self._request_id
            self._send(
                {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "method": "tools/call",
                    "params": {"name": name, "arguments": arguments},
                }
            )
            while True:
                msg = self._read_message()
                if msg.get("id") == req_id:
                    if "error" in msg:
                        raise McpProtocolError(str(msg["error"]))
                    result = msg.get("result") or {}
                    content = result.get("content") or []
                    if not content:
                        return {}
                    text = content[0].get("text", "{}")
                    if result.get("isError"):
                        raise McpProtocolError(text)
                    return json.loads(text) if isinstance(text, str) else text

    def _cached(self, key: str, fetch: Any) -> Any:
        now = time.monotonic()
        entry = self._cache.get(key)
        if entry and entry.expires_at > now:
            return entry.value
        value = fetch()
        self._cache[key] = _CacheEntry(
            value=value,
            expires_at=now + self._config.cache_ttl_seconds,
        )
        return value

    def invalidate_cache(self, project_dir: str | None = None) -> None:
        if project_dir is None:
            self._cache.clear()
            return
        self._cache.pop(f"progress:{project_dir}", None)

    def _read_progress_cli(self, project_dir: str) -> ProgressSnapshot:
        """Read progress via `gsd read progress --json` (6c hot path)."""
        result = subprocess.run(
            [
                self._config.cli_path,
                "read",
                "progress",
                "--json",
                "--project",
                project_dir,
            ],
            capture_output=True,
            text=True,
            check=False,
            timeout=60,
            env=self._env(),
        )
        if result.returncode != 0:
            raise McpProtocolError(
                (result.stderr or result.stdout or "gsd read progress failed").strip()
            )
        envelope = json.loads(result.stdout)
        data = envelope.get("data") or {}
        return ProgressSnapshot.from_mcp(data)

    def progress(self, project_dir: str) -> ProgressSnapshot:
        def fetch() -> ProgressSnapshot:
            try:
                self.ensure_version()
                return self._read_progress_cli(project_dir)
            except (
                GsdVersionError,
                McpProtocolError,
                json.JSONDecodeError,
                AttributeError,
                TypeError,
                KeyError,
                OSError,
                subprocess.TimeoutExpired,
            ):
                data = self._call_tool(
                    "gsd_progress",
                    {"projectDir": project_dir},
                    check_version=False,
                )
                return ProgressSnapshot.from_mcp(data)

        key = f"progress:{project_dir}"
        return self._cached(key, fetch)

    def status(self, session_id: str) -> SessionStatus:
        data = self._call_tool("gsd_status", {"sessionId": session_id})
        return SessionStatus.from_mcp(data)

    def execute(self, project_dir: str, *, command: str = "/gsd auto") -> dict[str, Any]:
        self.invalidate_cache(project_dir)
        return self._call_tool(
            "gsd_execute",
            {"projectDir": project_dir, "command": command},
        )

    def cancel(self, *, session_id: str | None = None, project_dir: str | None = None) -> dict[str, Any]:
        args: dict[str, Any] = {}
        if session_id:
            args["sessionId"] = session_id
        if project_dir:
            args["projectDir"] = project_dir
        return self._call_tool("gsd_cancel", args)

    def cancel_by_project(self, project_dir: str) -> dict[str, Any]:
        return self._call_tool("gsd_cancel_by_project", {"projectDir": project_dir})

    def resolve_blocker(self, session_id: str, response: str) -> dict[str, Any]:
        return self._call_tool(
            "gsd_resolve_blocker",
            {"sessionId": session_id, "response": response},
        )

    def memory_query(self, project_dir: str, query: str) -> dict[str, Any]:
        return self._call_tool(
            "gsd_memory_query",
            {"projectDir": project_dir, "query": query},
        )

    def close(self) -> None:
        if self._proc and self._proc.poll() is None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()
        self._proc = None
