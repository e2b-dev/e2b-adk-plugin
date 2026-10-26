"""e2b-adk — Google ADK plugin backed by E2B sandboxes."""

from __future__ import annotations

from importlib.metadata import version

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
__version__ = version("e2b-adk")
ConnectionConfig.set_integration(f"e2b-adk/{__version__}")

__all__ = [
    "E2BPlugin",
    "__version__",
    "ListFiles",
    "ReadFile",
    "RunCode",
    "RunCommand",
    "StartBackgroundCommand",
    "WriteFile",
]
