"""Hermes credential passthrough for MCP sidecar and headless (6b)."""

from __future__ import annotations

import os
from typing import Mapping

# Allowlisted env vars when credential_source is "hermes"
HERMES_CRED_ALLOWLIST = frozenset(
    {
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "GOOGLE_API_KEY",
        "GEMINI_API_KEY",
        "OPENROUTER_API_KEY",
        "GROQ_API_KEY",
    }
)


class CredentialPassthrough:
    """Map Hermes-resolved credentials to subprocess env."""

    def __init__(
        self,
        source: str,
        hermes_creds: Mapping[str, str] | None = None,
    ) -> None:
        self._source = source
        self._hermes_creds = dict(hermes_creds or {})

    def apply(self, base_env: dict[str, str] | None = None) -> dict[str, str]:
        env = dict(base_env or os.environ)
        if self._source != "hermes":
            return env
        for key, value in self._hermes_creds.items():
            if key in HERMES_CRED_ALLOWLIST and value:
                env[key] = value
        return env

    def validate(self) -> list[str]:
        """Return warnings when hermes source is selected but no creds mapped."""
        if self._source != "hermes":
            return []
        missing = [k for k in HERMES_CRED_ALLOWLIST if not self._hermes_creds.get(k)]
        if len(missing) == len(HERMES_CRED_ALLOWLIST):
            return [
                "credential_source=hermes but no allowlisted keys provided; "
                "falling back to gsd environment"
            ]
        return []
