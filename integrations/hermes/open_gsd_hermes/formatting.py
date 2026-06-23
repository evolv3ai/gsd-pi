"""Shared formatting helpers for GSD display values."""

from __future__ import annotations


def format_ref(ref: dict[str, str] | None, *, include_title: bool = True) -> str:
    if not ref:
        return "—"
    rid = ref.get("id", "")
    title = ref.get("title") or ""
    if include_title and rid and title:
        return f"{rid}: {title}"
    return rid or title or "—"
