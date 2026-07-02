"""Directory-loader compatibility tests."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType


def load_plugin_directory(plugin_root: Path) -> ModuleType:
    """Load the Hermes plugin the same way its directory loader does."""
    init_file = plugin_root / "__init__.py"
    if not init_file.exists():
        raise FileNotFoundError(f"No __init__.py in {plugin_root}")

    spec = importlib.util.spec_from_file_location(
        "open_gsd_hermes_directory_loader",
        init_file,
        submodule_search_locations=[str(plugin_root)],
    )
    assert spec is not None
    assert spec.loader is not None

    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_plugin_root_supports_hermes_directory_loader() -> None:
    plugin_root = Path(__file__).resolve().parents[1]

    module = load_plugin_directory(plugin_root)

    assert callable(module.register)
    assert module.__all__ == ["register"]
