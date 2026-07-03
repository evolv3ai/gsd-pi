"""open-gsd-hermes — Hermes Agent plugin directory-loader bridge."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType


def _load_package() -> ModuleType:
    package_dir = Path(__file__).resolve().parent / "open_gsd_hermes"
    init_file = package_dir / "__init__.py"
    spec = importlib.util.spec_from_file_location(
        "open_gsd_hermes",
        init_file,
        submodule_search_locations=[str(package_dir)],
    )
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load open_gsd_hermes from {init_file}")

    module = importlib.util.module_from_spec(spec)
    sys.modules["open_gsd_hermes"] = module
    spec.loader.exec_module(module)
    return module


_package = _load_package()
register = _package.register

__all__ = ["register"]
