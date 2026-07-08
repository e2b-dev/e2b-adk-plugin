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

#: Tool-arg keys whose *values* are masked before logging: ``envs`` may carry
#: credentials, and ``content`` / ``code`` may be large or sensitive payloads.
#: Other args (path, command, port, ...) are logged as-is to keep the trace useful.
_SENSITIVE_ARG_KEYS = frozenset({"content", "code", "envs"})


def _redact_args(tool_args: dict[str, Any]) -> dict[str, Any]:
    """Return a shallow copy of ``tool_args`` with sensitive values masked."""
    if not isinstance(tool_args, dict):
        return tool_args
    return {
        key: ("<redacted>" if key in _SENSITIVE_ARG_KEYS else value)
        for key, value in tool_args.items()
    }


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
        secure: bool | None = None,
        allow_internet_access: bool | None = None,
        mcp: Any | None = None,
        network: Any | None = None,
        lifecycle: Any | None = None,
        volume_mounts: Any | None = None,
        plugin_name: str = "e2b_plugin",
        **opts: Any,
    ) -> None:
        """Build the plugin and its (lazy) ``SandboxManager``.

        Every option except ``plugin_name`` maps to an ``AsyncSandbox.create``
        parameter and is forwarded verbatim; only options the caller actually
        set (non-``None``) are passed, so E2B's own defaults apply otherwise.

        The named parameters cover ``create``'s sandbox options. Any further
        keyword arguments (``**opts``) are forwarded verbatim too, covering the
        connection-level ``ApiParams`` (``proxy``, ``request_timeout``,
        ``headers``, ...) and any future ``create`` parameter without a plugin
        change — the plugin stays a thin, neutral passthrough.

        ``api_key`` is optional and normally omitted: when it is ``None`` the
        E2B SDK reads ``E2B_API_KEY`` from the environment automatically, which
        is the recommended way to supply the credential (keep it out of source).

        ``lifecycle`` controls what happens when the sandbox times out. Omitting
        it keeps E2B's default (``on_timeout: "kill"``); pass e.g.
        ``{"on_timeout": {"action": "pause"}, "auto_resume": True}`` to preserve
        state across idle gaps instead.
        """
        super().__init__(name=plugin_name)

        named: dict[str, Any] = {
            "api_key": api_key,
            "template": template,
            "metadata": metadata,
            "envs": envs,
            "timeout": timeout,
            "secure": secure,
            "allow_internet_access": allow_internet_access,
            "mcp": mcp,
            "network": network,
            "lifecycle": lifecycle,
            "volume_mounts": volume_mounts,
        }
        # Forward only the named options the caller actually set, plus any extra
        # keyword args verbatim (e.g. connection-level ApiParams).
        forwarded = {key: value for key, value in named.items() if value is not None}
        forwarded.update(opts)
        self._manager = SandboxManager(**forwarded)

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

    def _owns(self, tool: BaseTool) -> bool:
        """Whether ``tool`` is one of this plugin's own sandbox tools.

        ADK dispatches plugin callbacks for *every* tool in the app, including
        tools this plugin didn't create. Ownership is checked by identity on the
        shared ``SandboxManager`` so foreign tools are left alone — no misleading
        "E2B tool" log lines and no warnings about other tools' result shapes.
        """
        return getattr(tool, "manager", None) is self._manager

    async def before_tool_callback(
        self,
        *,
        tool: BaseTool,
        tool_args: dict[str, Any],
        tool_context: ToolContext,
    ) -> dict[str, Any] | None:
        """Keep the sandbox alive and log the tool about to run (non-intrusive)."""
        if not self._owns(tool):
            return None
        # Reset the sandbox's expiry window on every tool call so a busy session
        # outlives the E2B timeout (default 300s, counted from creation or the
        # last set_timeout — not from last use). No-op before the sandbox exists;
        # best-effort, never breaks the call.
        await self._manager.refresh_timeout()
        logger.debug("E2B tool starting: %s args=%s", tool.name, _redact_args(tool_args))
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
        if not self._owns(tool):
            return None
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
        if not self._owns(tool):
            return None
        logger.error("E2B tool %s raised an uncaught exception: %s", tool.name, error)
        return None
