"""Persistent gsd-mcp-server MCP client (stdio JSON-RPC)."""

from __future__ import annotations

import json
import os
import subprocess
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable

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
        self._proc_cwd: str | None = None
        self._stdout_buffer = b""
        self._lock = threading.Lock()
        self._request_id = 0
        self._cache: dict[str, _CacheEntry] = {}
        self._version_checked = False
        # Milestone subprocess state (issue #1162). The plugin owns the
        # `gsd headless --supervised new-milestone` process directly, so the
        # MCP session manager cannot see or reach it. This client is the sole
        # owner of its lifecycle (cancel, blocker replies, terminal events).
        self._milestone_proc: subprocess.Popen[bytes] | None = None
        self._milestone_session_id: str | None = None
        self._milestone_pending_blocker_id: str | None = None
        self._milestone_notifications: Any = None  # NotificationService | None
        self._milestone_on_terminal: Callable[[str], None] | None = None
        self._milestone_notified_terminal: bool = False
        self._milestone_thread: threading.Thread | None = None

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

    def _ensure_process(self, project_dir: str | None = None) -> subprocess.Popen[bytes]:
        cwd = (
            os.path.abspath(project_dir)
            if project_dir is not None
            else self._proc_cwd
        )
        if self._proc is not None and self._proc.poll() is None:
            if cwd is None or self._proc_cwd == cwd:
                return self._proc
            self._terminate_process()
        self._stdout_buffer = b""
        self._proc_cwd = cwd
        self._proc = subprocess.Popen(
            [self._config.mcp_server_path],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=self._env(),
            cwd=cwd,
        )
        try:
            self._initialize()
        except Exception:
            self._terminate_process()
            raise
        return self._proc

    def _terminate_process(self) -> None:
        proc = self._proc
        self._proc = None
        self._proc_cwd = None
        self._stdout_buffer = b""
        if proc is None or proc.poll() is not None:
            return
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

    def _send(self, payload: dict[str, Any], *, project_dir: str | None = None) -> None:
        proc = self._ensure_process(project_dir)
        assert proc.stdin is not None
        body = json.dumps(payload).encode("utf-8")
        header = f"Content-Length: {len(body)}\r\n\r\n".encode("ascii")
        proc.stdin.write(header + body)
        proc.stdin.flush()

    def _read_stdout_chunk(self, deadline: float) -> None:
        proc = self._proc
        if proc is None or proc.poll() is not None:
            self._terminate_process()
            raise McpProtocolError("MCP server closed stdout")
        assert proc.stdout is not None
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            self._raise_read_timeout()

        chunks: list[bytes] = []
        errors: list[BaseException] = []

        def read_chunk() -> None:
            try:
                chunks.append(os.read(proc.stdout.fileno(), 65536))
            except BaseException as e:
                errors.append(e)

        reader = threading.Thread(target=read_chunk, daemon=True)
        reader.start()
        reader.join(remaining)
        if reader.is_alive():
            self._raise_read_timeout()
        if errors:
            self._terminate_process()
            raise McpProtocolError(f"MCP server stdout read failed: {errors[0]}")
        chunk = chunks[0] if chunks else b""
        if not chunk:
            self._terminate_process()
            raise McpProtocolError("MCP server closed stdout")
        self._stdout_buffer += chunk

    def _raise_read_timeout(self) -> None:
        self._terminate_process()
        raise McpProtocolError(
            f"MCP server response timed out after "
            f"{self._config.mcp_read_timeout_seconds:g}s"
        )

    def _read_header(self, deadline: float) -> bytes:
        while True:
            crlf_idx = self._stdout_buffer.find(b"\r\n\r\n")
            lf_idx = self._stdout_buffer.find(b"\n\n")
            candidates = [
                (idx, sep_len)
                for idx, sep_len in ((crlf_idx, 4), (lf_idx, 2))
                if idx >= 0
            ]
            if candidates:
                idx, sep_len = min(candidates)
                header = self._stdout_buffer[:idx]
                self._stdout_buffer = self._stdout_buffer[idx + sep_len :]
                return header
            self._read_stdout_chunk(deadline)

    def _read_exact(self, length: int, deadline: float) -> bytes:
        while len(self._stdout_buffer) < length:
            self._read_stdout_chunk(deadline)
        body = self._stdout_buffer[:length]
        self._stdout_buffer = self._stdout_buffer[length:]
        return body

    def _read_message(self) -> dict[str, Any]:
        deadline = time.monotonic() + self._config.mcp_read_timeout_seconds
        header = self._read_header(deadline)
        headers: dict[str, str] = {}
        for raw_line in header.splitlines():
            decoded = raw_line.decode("utf-8").strip()
            if not decoded:
                continue
            key, _, val = decoded.partition(":")
            headers[key.strip().lower()] = val.strip()
        length = int(headers.get("content-length", "0"))
        body = self._read_exact(length, deadline)
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
        self,
        name: str,
        arguments: dict[str, Any],
        *,
        check_version: bool = True,
        project_dir: str | None = None,
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
                },
                project_dir=project_dir,
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
                    project_dir=project_dir,
                )
                return ProgressSnapshot.from_mcp(data)

        key = f"progress:{project_dir}"
        return self._cached(key, fetch)

    def status(self, session_id: str) -> SessionStatus:
        data = self._call_tool("gsd_status", {"sessionId": session_id})
        return SessionStatus.from_mcp(data)

    def execute(self, project_dir: str, *, command: str = "/gsd auto") -> dict[str, Any]:
        self.invalidate_cache(project_dir)
        args = {"projectDir": project_dir, "command": command}
        try:
            return self._call_tool("gsd_execute", args, project_dir=project_dir)
        except GsdVersionError:
            return self._call_tool(
                "gsd_execute",
                args,
                check_version=False,
                project_dir=project_dir,
            )

    def cancel(
        self,
        *,
        session_id: str | None = None,
        project_dir: str | None = None,
    ) -> dict[str, Any]:
        args: dict[str, Any] = {}
        if session_id:
            args["sessionId"] = session_id
        if project_dir:
            args["projectDir"] = project_dir
        return self._call_tool("gsd_cancel", args, project_dir=project_dir)

    def cancel_by_project(self, project_dir: str) -> dict[str, Any]:
        return self._call_tool(
            "gsd_cancel_by_project",
            {"projectDir": project_dir},
            project_dir=project_dir,
        )

    def resolve_blocker(self, session_id: str, response: str) -> dict[str, Any]:
        return self._call_tool(
            "gsd_resolve_blocker",
            {"sessionId": session_id, "response": response},
        )

    def memory_query(self, project_dir: str, query: str) -> dict[str, Any]:
        return self._call_tool(
            "gsd_memory_query",
            {"projectDir": project_dir, "query": query},
            project_dir=project_dir,
        )

    # ------------------------------------------------------------------
    # Milestone creation (issue #1162)
    #
    # The plugin spawns `gsd headless --supervised new-milestone` directly
    # and owns the subprocess. The MCP session manager cannot see it (it
    # only knows sessions it started via gsd_execute), and there is no
    # auto.lock pid backstop during the planning phase. So this client is
    # the sole owner of the subprocess's lifecycle: cancel (SIGTERM),
    # blocker replies (stdin), and transition/terminal notifications
    # (stdout stream). See integrations/hermes/docs/issue-1162-grilling.md.
    # ------------------------------------------------------------------

    # Stop-notice vocabulary mirrored from src/resources/extensions/gsd/stop-notice.ts.
    # Keep both sides in lockstep; the canonical prefixes the headless event
    # loop emits in notify messages. Terminal detection is handled by process
    # exit (the stream reader emits notify_terminal on stdout EOF), so only the
    # blocked-notice classifier is needed here.
    _PAUSED_NOTICE_PREFIXES = ("auto-mode paused", "step-mode paused")
    _EXIT_BLOCKED = 10

    def _is_blocked_notice(self, message: str) -> bool:
        """Mirror of stop-notice.ts isBlockedNoticeMessage (lowercased input)."""
        if "blocked:" in message:
            return True
        if any(message.startswith(p) for p in self._PAUSED_NOTICE_PREFIXES):
            if "idempotent advance: unit already active" not in message:
                return True
        return (
            "resolve manually and re-run /gsd auto" in message
            or "resolve conflicts manually and run /gsd auto to resume" in message
            or "resolve and run /gsd auto to resume" in message
        )

    def create_milestone(
        self,
        project_dir: str,
        *,
        context_text: str | None = None,
        context_file: str | None = None,
        notifications: Any = None,
        on_terminal: Callable[[str], None] | None = None,
    ) -> str:
        """Spawn `gsd headless --supervised new-milestone` and return the sessionId.

        The subprocess is started detached; a background thread reads its
        stream-json stdout, captures init_result.sessionId, and drives the
        supplied NotificationService on blocker/terminal events. The caller
        receives the sessionId once the init_result event arrives.

        Raises ValueError if neither (or both) of context_text/context_file
        is supplied.
        """
        if bool(context_text) == bool(context_file):
            raise ValueError(
                "Provide exactly one milestone spec: context_text or context_file"
            )
        self.ensure_version()
        if self._milestone_proc is not None and self._milestone_proc.poll() is None:
            raise RuntimeError("Milestone creation already in progress.")

        args: list[str] = [
            self._config.cli_path,
            "headless",
            "--supervised",
            "--output-format",
            "stream-json",
        ]
        if context_text:
            args += ["--context-text", context_text]
        else:
            assert context_file is not None
            args += ["--context", context_file]
        args.append("new-milestone")

        proc = subprocess.Popen(  # noqa: S603 - args list, not shell
            args,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=project_dir,
            env=self._env(),
        )
        self._milestone_proc = proc
        self._milestone_session_id = None
        self._milestone_pending_blocker_id = None
        self._milestone_notifications = notifications
        self._milestone_on_terminal = on_terminal
        self._milestone_notified_terminal = False
        threading.Thread(
            target=self._drain_milestone_stderr,
            args=(proc,),
            daemon=True,
        ).start()

        # Read init_result synchronously so the caller gets the sessionId
        # before the ack returns. The stream loop then continues in the
        # background for blocker/terminal events.
        assert proc.stdout is not None
        try:
            session_id = self._read_init_result(proc)
        except Exception:
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                pass
            self._clear_milestone_state()
            raise
        self._milestone_session_id = session_id

        self._milestone_thread = threading.Thread(
            target=self._milestone_stream_loop,
            args=(proc,),
            daemon=True,
        )
        self._milestone_thread.start()
        return session_id

    def _read_init_result(self, proc: subprocess.Popen[bytes]) -> str:
        """Block reading stdout lines until init_result yields a sessionId."""
        assert proc.stdout is not None
        while True:
            line = proc.stdout.readline()
            if not line:
                raise McpProtocolError(
                    "new-milestone subprocess closed stdout before init_result"
                )
            try:
                event = json.loads(line.decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue
            if event.get("type") == "init_result":
                sid = event.get("sessionId")
                if not sid:
                    raise McpProtocolError("init_result arrived without sessionId")
                return str(sid)

    def _milestone_stream_loop(self, proc: subprocess.Popen[bytes]) -> None:
        """Background reader: capture blocker/terminal events and notify.

        Best-effort. On stream loss we surface FAILED via notify_terminal so
        the user can `/gsd cancel` to clean up (no watchdog; the cancel
        escape hatch is the safety net).
        """
        assert proc.stdout is not None
        try:
            while True:
                line = proc.stdout.readline()
                if not line:
                    break
                try:
                    event = json.loads(line.decode("utf-8"))
                except (json.JSONDecodeError, UnicodeDecodeError):
                    continue
                self._handle_milestone_event(event)
        except Exception:
            pass
        if self._milestone_notified_terminal:
            self._release_milestone_proc()
            return
        exit_code = proc.poll()
        if exit_code is None:
            try:
                exit_code = proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                exit_code = None
        if exit_code == self._EXIT_BLOCKED:
            return
        if exit_code == 0:
            status = "complete"
            error: str | None = None
        elif exit_code is not None:
            status = "failed"
            err_bytes = proc.stderr.read() if proc.stderr is not None else b""
            error = (
                err_bytes.decode("utf-8", errors="replace").strip()
                or f"exit code {exit_code}"
            )
        else:
            status = "failed"
            error = "stream lost — run /gsd cancel"
        if self._milestone_notifications is not None:
            self._milestone_notifications.notify_terminal(status, error)
        if self._milestone_on_terminal is not None:
            self._milestone_on_terminal(status)
        self._milestone_notified_terminal = True
        self._release_milestone_proc()

    def _drain_milestone_stderr(self, proc: subprocess.Popen[bytes]) -> None:
        """Drain stderr so a full pipe cannot stall the child process."""
        if proc.stderr is None:
            return
        try:
            for _ in proc.stderr:
                pass
        except Exception:
            pass

    def _handle_milestone_event(self, event: dict[str, Any]) -> None:
        etype = event.get("type")
        if etype == "init_result":
            sid = event.get("sessionId")
            if sid:
                self._milestone_session_id = str(sid)
            return
        if etype != "extension_ui_request":
            return
        message = str(event.get("message") or "").lower()
        event_id = str(event.get("id") or "")
        if self._is_blocked_notice(message):
            self._milestone_pending_blocker_id = event_id or None
            if self._milestone_notifications is not None:
                self._milestone_notifications.notify_blocker(
                    SessionStatus(
                        status="blocked",
                        pending_blocker=event,
                        session_id=self._milestone_session_id,
                    )
                )

    def cancel_milestone(self) -> None:
        """SIGTERM the held milestone subprocess and clear state."""
        proc = self._milestone_proc
        if proc is None:
            return
        self._milestone_notified_terminal = True
        try:
            proc.terminate()
        except Exception:
            pass
        self._clear_milestone_state()

    def _release_milestone_proc(self) -> None:
        self._milestone_proc = None
        self._milestone_notifications = None
        self._milestone_on_terminal = None

    def _clear_milestone_state(self) -> None:
        self._release_milestone_proc()
        self._milestone_session_id = None
        self._milestone_pending_blocker_id = None

    def respond_to_milestone_blocker(self, response: str) -> None:
        """Write an extension_ui_response to the milestone subprocess stdin.

        Uses the supervised-mode JSONL protocol (see startSupervisedStdinReader
        in src/headless-ui.ts): {"type":"extension_ui_response","id":...,"value":...}.
        """
        proc = self._milestone_proc
        blocker_id = self._milestone_pending_blocker_id
        if proc is None or not blocker_id:
            raise RuntimeError(
                "No pending blocker for the active milestone session."
            )
        assert proc.stdin is not None
        payload = json.dumps(
            {"type": "extension_ui_response", "id": blocker_id, "value": response}
        ).encode("utf-8")
        proc.stdin.write(payload + b"\n")
        proc.stdin.flush()
        self._milestone_pending_blocker_id = None

    def milestone_active(self) -> bool:
        return self._milestone_proc is not None

    def milestone_session_id(self) -> str | None:
        return self._milestone_session_id

    def milestone_pending_blocker_id(self) -> str | None:
        return self._milestone_pending_blocker_id

    def close(self) -> None:
        self._terminate_process()
        if self._milestone_proc is not None:
            self.cancel_milestone()
