"""Golden test for federated memory prefetch (6c)."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

from open_gsd_hermes.config import GsdConfig
from open_gsd_hermes.gsd_client import GsdMcpClient
from open_gsd_hermes.memory import GsdMemoryProvider

GOLDEN = Path(__file__).parent / "golden" / "memory_prefetch.txt"


def test_memory_prefetch_golden(tmp_path: Path) -> None:
    memory_file = tmp_path / "MEMORY.md"
    memory_file.write_text("User prefers concise Slack updates.\n", encoding="utf-8")

    config = GsdConfig(hermes_memory_path=str(memory_file))
    client = MagicMock(spec=GsdMcpClient)
    client.memory_query.return_value = {
        "memories": [{"content": "Auth uses JWT with refresh rotation"}],
    }

    provider = GsdMemoryProvider(config, client)
    rendered = provider.prefetch("/tmp/project", query="auth")
    expected = GOLDEN.read_text(encoding="utf-8").strip()
    assert rendered.strip() == expected


def test_memory_prefetch_ignores_empty_memory_results() -> None:
    config = GsdConfig()
    client = MagicMock(spec=GsdMcpClient)
    client.memory_query.return_value = {"memories": []}

    provider = GsdMemoryProvider(config, client)
    rendered = provider.prefetch("/tmp/project", query="auth")

    assert rendered == ""


def test_memory_prefetch_keeps_multiple_gsd_memories_in_one_list() -> None:
    config = GsdConfig()
    client = MagicMock(spec=GsdMcpClient)
    client.memory_query.return_value = {
        "memories": [
            {"content": "Auth uses JWT with refresh rotation"},
            {"content": "Billing runs through Stripe"},
        ],
    }

    provider = GsdMemoryProvider(config, client)
    rendered = provider.prefetch("/tmp/project", query="auth")

    assert rendered == (
        "## GSD memories\n"
        "- Auth uses JWT with refresh rotation\n"
        "- Billing runs through Stripe"
    )
