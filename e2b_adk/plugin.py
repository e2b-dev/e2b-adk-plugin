"""E2BPlugin — a ``google.adk.plugins.BasePlugin`` backed by an E2B sandbox.

The plugin owns a single :class:`~e2b_adk._sandbox.SandboxManager` built from
its constructor options. No sandbox is created at construction time — the
manager creates one lazily on the first tool call and reuses it until
:meth:`close` tears it down.

``get_tools()`` is a package convenience (not an ADK override) that returns the
execution tools, all sharing the plugin's single ``SandboxManager`` so every
tool call targets the same sandbox.
"""

from __future__ import annotations

import logging
from typing import Any

from google.adk.plugins import BasePlugin
from google.adk.tools import BaseTool, ToolContext

from ._sandbox import SandboxManager
from .tools import (
    ListFiles,
    ReadFile,
    RunCode,
    RunCommand,
    StartBackgroundCommand,
    WriteFile,
)

logger = logging.getLogger(__name__)


class E2BPlugin(BasePlugin):
    """ADK plugin that runs tool calls inside a shared E2B sandbox.

    Constructor options (all optional) are forwarded to the owned
    ``SandboxManager`` and, through it, to ``AsyncSandbox.create(...)`` on first
    use. Only the options that were actually supplied (non-``None``) are
    forwarded, so E2B's own defaults apply otherwise.
    """

    def __init__(
        self,
        *,
        api_key: str | None = None,
        template: str | None = None,
        metadata: dict[str, str] | None = None,
        envs: dict[str, str] | None = None,
        timeout: int | None = None,
        plugin_name: str = "e2b_plugin",
    ) -> None:
        super().__init__(name=plugin_name)

        opts: dict[str, Any] = {
            "api_key": api_key,
            "template": template,
            "metadata": metadata,
            "envs": envs,
            "timeout": timeout,
        }
        # Forward only the options the caller actually set.
        opts = {key: value for key, value in opts.items() if value is not None}
        self._manager = SandboxManager(**opts)

    def get_tools(self) -> list[BaseTool]:
        """Return the execution tools, all sharing this plugin's sandbox.

        Not an ADK override — a convenience so callers can wire the tools into
        an ``Agent``. Each tool receives the plugin's single ``SandboxManager``
        instance, so every tool call targets the same lazily-created sandbox.
        """
        return [
            RunCode(self._manager),
            RunCommand(self._manager),
            WriteFile(self._manager),
            ReadFile(self._manager),
            ListFiles(self._manager),
            StartBackgroundCommand(self._manager),
        ]

    async def close(self) -> None:
        """Tear down the sandbox on plugin shutdown (ADK teardown hook)."""
        await self._manager.shutdown()

    async def before_tool_callback(
        self,
        *,
        tool: BaseTool,
        tool_args: dict[str, Any],
        tool_context: ToolContext,
    ) -> dict[str, Any] | None:
        """Log the tool about to run inside the sandbox (non-intrusive)."""
        logger.debug("E2B tool starting: %s args=%s", tool.name, tool_args)
        return None

    async def after_tool_callback(
        self,
        *,
        tool: BaseTool,
        tool_args: dict[str, Any],
        tool_context: ToolContext,
        result: dict[str, Any],
    ) -> dict[str, Any] | None:
        """Log the outcome of a sandbox tool call (non-intrusive).

        A tool that returns ``success: False`` (a failure it *handled* per the
        result contract) is surfaced at warning level; an exception that escapes
        a tool is handled separately in :meth:`on_tool_error_callback`.
        """
        if isinstance(result, dict) and result.get("success") is False:
            logger.warning(
                "E2B tool %s returned a failure result: %s",
                tool.name,
                result.get("error"),
            )
        else:
            logger.debug("E2B tool finished: %s", tool.name)
        return None

    async def on_tool_error_callback(
        self,
        *,
        tool: BaseTool,
        tool_args: dict[str, Any],
        tool_context: ToolContext,
        error: Exception,
    ) -> dict[str, Any] | None:
        """Log an *uncaught* tool exception.

        The tools return failures via the result contract rather than raising,
        so reaching here indicates a bug or an unexpected SDK error worth a
        louder log line. Returns ``None`` (no result substitution).
        """
        logger.error("E2B tool %s raised an uncaught exception: %s", tool.name, error)
        return None
