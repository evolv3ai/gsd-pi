"""Format ProgressResult into compact pre_llm_call context (~15 lines)."""

from __future__ import annotations

from open_gsd_hermes.formatting import format_ref
from open_gsd_hermes.types import ProgressSnapshot


def format_snapshot(progress: ProgressSnapshot) -> str:
    """Compact GSD project snapshot for pre_llm_call injection."""
    lines = [
        "## GSD Project Snapshot",
        f"Phase: {progress.phase}",
        f"Active milestone: {format_ref(progress.active_milestone)}",
        f"Active slice: {format_ref(progress.active_slice)}",
        f"Active task: {format_ref(progress.active_task)}",
    ]
    if progress.milestones:
        m = progress.milestones
        lines.append(
            f"Milestones: {m.get('done', 0)}/{m.get('total', 0)} done "
            f"({m.get('active', 0)} active)"
        )
    if progress.slices and progress.slices.get("total", 0) > 0:
        s = progress.slices
        lines.append(f"Slices: {s.get('done', 0)}/{s.get('total', 0)} done")
    if progress.tasks and progress.tasks.get("total", 0) > 0:
        t = progress.tasks
        lines.append(f"Tasks: {t.get('done', 0)}/{t.get('total', 0)} done")
    if progress.requirements:
        r = progress.requirements
        lines.append(
            f"Requirements: {r.get('active', 0)} active, "
            f"{r.get('validated', 0)} validated"
        )
    if progress.blockers:
        lines.append("Blockers:")
        for b in progress.blockers[:3]:
            lines.append(f"  - {b}")
    if progress.next_action:
        lines.append(f"Next: {progress.next_action}")
    return "\n".join(lines[:15])
