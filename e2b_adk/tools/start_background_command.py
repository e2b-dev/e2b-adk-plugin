"""``start_background_command`` — start a long-running process, return immediately."""

from __future__ import annotations

import logging
from typing import Any

from google.adk.tools import BaseTool, ToolContext
from google.genai import types

from .._results import failure_result, success_result
from .._sandbox import SandboxManager
from ._common import _require_str

logger = logging.getLogger(__name__)


class StartBackgroundCommand(BaseTool):
    """Start a long-running command in the E2B sandbox and return immediately.

    Backed by ``AsyncSandbox.commands.run(..., background=True)``, which returns
    an ``AsyncCommandHandle`` right away; this tool reports its ``pid`` without
    waiting for the process to become ready. The E2B process is backgrounded,
    but this is a regular ADK tool call because its complete result is returned
    immediately; no later ``FunctionResponse`` is injected.

    When a ``port`` is given, a ``preview_url`` is built from the *synchronous*
    ``sandbox.get_host(port)`` (a bare host, e.g. ``<port>-<id>.e2b.app``). The
    URL is purely syntactic — the service may not be listening yet — so
    ``readiness`` is reported as ``"unknown"``. With no ``port`` there is no
    preview URL (``preview_url`` is ``None``). Only a failure to *start* the
    command yields ``success: False``; v1 does not detect an immediate exit.
    """

    def __init__(self, manager: SandboxManager) -> None:
        super().__init__(
            name="start_background_command",
            description=(
                "Start a long-running command (such as a web/dev server) inside "
                "an isolated E2B sandbox and return immediately with its process "
                "id. Provide a port to also get a preview URL for the exposed "
                "service; the URL is syntactic and readiness is not verified."
            ),
        )
        self.manager = manager

    def _get_declaration(self) -> types.FunctionDeclaration:
        return types.FunctionDeclaration(
            name=self.name,
            description=self.description,
            parameters=types.Schema(
                type=types.Type.OBJECT,
                properties={
                    "command": types.Schema(
                        type=types.Type.STRING,
                        description="The command to start in the background.",
                    ),
                    "port": types.Schema(
                        type=types.Type.INTEGER,
                        description=(
                            "Optional port the command exposes; when given, a "
                            "preview URL for that port is returned."
                        ),
                    ),
                    "cwd": types.Schema(
                        type=types.Type.STRING,
                        description="Optional working directory for the command.",
                    ),
                    "envs": types.Schema(
                        type=types.Type.OBJECT,
                        description="Optional environment variables for the command.",
                    ),
                    "timeout": types.Schema(
                        type=types.Type.INTEGER,
                        description=(
                            "Optional max lifetime in seconds for the background "
                            "process before the sandbox stops it (E2B default is "
                            "60s). Pass a larger value for a long-lived server, or "
                            "0 to disable the timeout."
                        ),
                    ),
                },
                required=["command"],
            ),
        )

    async def run_async(
        self, *, args: dict[str, Any], tool_context: ToolContext
    ) -> dict[str, Any]:
        command = _require_str(args, "command")
        if command is None:
            return failure_result("Missing or invalid required argument: command")
        raw_port = args.get("port")
        if raw_port is None:
            port: int | None = None
        elif (
            isinstance(raw_port, int)
            and not isinstance(raw_port, bool)
            and 1 <= raw_port <= 65535
        ):
            port = raw_port
        else:
            return failure_result(
                "Invalid port: expected an integer between 1 and 65535",
                command=command,
            )
        cwd: str | None = args.get("cwd")
        envs: dict[str, str] | None = args.get("envs")
        timeout: int | None = args.get("timeout")

        try:
            sandbox = await self.manager.get()
        except Exception as exc:  # noqa: BLE001 — never raise out of run_async
            logger.debug("start_background_command: sandbox unavailable: %s", exc)
            return failure_result(f"Sandbox unavailable: {exc}", command=command)

        run_kwargs: dict[str, Any] = {"background": True, "cwd": cwd, "envs": envs}
        if timeout is not None:
            run_kwargs["timeout"] = timeout

        try:
            handle = await sandbox.commands.run(command, **run_kwargs)
        except Exception as exc:  # noqa: BLE001 — start failure → success:false
            logger.debug("start_background_command: could not start: %s", exc)
            return failure_result(f"Failed to start command: {exc}", command=command)

        # No port → no preview URL. get_host is synchronous (no await).
        if port is None:
            return success_result(command=command, pid=handle.pid, preview_url=None)

        # The command already started (we hold its pid), so a failure to build the
        # preview URL must not raise or lose that pid — degrade to no URL instead.
        try:
            host = sandbox.get_host(port)
        except Exception as exc:  # noqa: BLE001 — never raise out of run_async
            logger.debug("start_background_command: could not resolve host: %s", exc)
            return success_result(
                command=command,
                pid=handle.pid,
                preview_url=None,
                readiness="unknown",
            )

        return success_result(
            command=command,
            pid=handle.pid,
            preview_url=f"https://{host}",
            readiness="unknown",
        )
