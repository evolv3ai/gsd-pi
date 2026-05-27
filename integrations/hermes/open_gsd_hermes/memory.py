"""MemoryProvider — federated read, GSD-authoritative write (6c)."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Protocol

from open_gsd_hermes.config import GsdConfig
from open_gsd_hermes.gsd_client import GsdMcpClient


class MemoryProvider(Protocol):
    def prefetch(self, project_dir: str, query: str | None = None) -> str: ...


class GsdMemoryProvider:
    """
    Federated memory prefetch:
    - GSD memories via gsd_memory_query (authoritative)
    - Optional read-only Hermes MEMORY.md snippet
    Writes go only to GSD (via MCP tools), never to Hermes memory files.
    """

    def __init__(
        self,
        config: GsdConfig,
        client: GsdMcpClient,
        *,
        read_cli_path: str | None = None,
    ) -> None:
        self._config = config
        self._client = client
        self._read_cli = read_cli_path or config.cli_path

    def prefetch(self, project_dir: str, query: str | None = None) -> str:
        sections: list[str] = []
        if query and len(query) >= 2:
            try:
                data = self._client.memory_query(project_dir, query)
                memories = data.get("memories") or data.get("results") or data
                if memories:
                    sections.append("## GSD memories")
                    if isinstance(memories, list):
                        for m in memories[:8]:
                            if isinstance(m, dict):
                                sections.append(f"- {m.get('content', m)}")
                            else:
                                sections.append(f"- {m}")
                    else:
                        sections.append(str(memories)[:2000])
            except Exception as e:
                sections.append(f"## GSD memories\n(unavailable: {e})")

        hermes_path = self._config.hermes_memory_path
        if hermes_path:
            p = Path(hermes_path).expanduser()
            if p.is_file():
                text = p.read_text(encoding="utf-8")[:1500]
                sections.append("## Hermes MEMORY.md (read-only)\n" + text)

        return "\n\n".join(sections) if sections else ""
