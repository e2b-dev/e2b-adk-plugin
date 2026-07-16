"""e2b-adk — Google ADK plugin backed by E2B sandboxes."""

from __future__ import annotations

from e2b import ConnectionConfig

from .plugin import E2BPlugin
from .tools import (
    ListFiles,
    ReadFile,
    RunCode,
    RunCommand,
    StartBackgroundCommand,
    WriteFile,
)

# E2B's integration hook is process-wide and must be set before the SDK builds
# a connection config. Importing the modules above has no runtime side effects;
# plugin construction can only happen after package initialization completes.
ConnectionConfig.set_integration("e2b-adk/0.1.0")

__all__ = [
    "E2BPlugin",
    "ListFiles",
    "ReadFile",
    "RunCode",
    "RunCommand",
    "StartBackgroundCommand",
    "WriteFile",
]
