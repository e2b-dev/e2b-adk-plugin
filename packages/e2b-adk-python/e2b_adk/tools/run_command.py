"""``run_command`` — run a shell command in the sandbox."""

from __future__ import annotations

import logging
from typing import Any

from e2b_code_interpreter import CommandExitException
from google.adk.tools import BaseTool, ToolContext
from google.genai import types

from .._results import failure_result, success_result, truncate_output
from .._sandbox import SandboxManager
from ._common import _require_str

logger = logging.getLogger(__name__)


class RunCommand(BaseTool):
    """Run a shell command inside the E2B sandbox and return its result.

    Backed by ``AsyncSandbox.commands.run``. A command that exits non-zero
    raises ``CommandExitException`` in the SDK; that is caught here and mapped
    to ``success: True`` (the command *ran*) carrying the non-zero
    ``exit_code`` and captured output. Only an inability to run the command
    (sandbox unavailable / timeout) yields ``success: False``.

    Each call is independent: the ``cwd`` and ``envs`` do not persist across
    calls, since a fresh command process is spawned each time.
    """

    def __init__(self, manager: SandboxManager) -> None:
        super().__init__(
            name="run_command",
            description=(
                "Run a shell command inside an isolated E2B sandbox and return "
                "its stdout, stderr, and exit code. Use this for shell tasks "
                "such as installing packages or inspecting the filesystem. "
                "cwd and env vars do not persist between calls."
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
                        description="The shell command to run in the sandbox.",
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
                        description="Optional timeout in seconds for the command.",
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
        cwd: str | None = args.get("cwd")
        envs: dict[str, str] | None = args.get("envs")
        timeout: int | None = args.get("timeout")

        try:
            sandbox = await self.manager.get()
        except Exception as exc:  # noqa: BLE001 — never raise out of run_async
            logger.debug("run_command: sandbox unavailable: %s", exc)
            return failure_result(f"Sandbox unavailable: {exc}", command=command)

        run_kwargs: dict[str, Any] = {"cwd": cwd, "envs": envs}
        if timeout is not None:
            run_kwargs["timeout"] = timeout

        try:
            async with self.manager.keep_alive(sandbox):
                result = await sandbox.commands.run(command, **run_kwargs)
        except CommandExitException as exc:
            # The command ran but exited non-zero — that is a successful call.
            return success_result(
                command=command,
                stdout=truncate_output(exc.stdout or ""),
                stderr=truncate_output(exc.stderr or ""),
                exit_code=exc.exit_code,
            )
        except Exception as exc:  # noqa: BLE001 — SDK/timeout failure → success:false
            logger.debug("run_command: command could not run: %s", exc)
            return failure_result(f"Failed to run command: {exc}", command=command)

        return success_result(
            command=command,
            stdout=truncate_output(result.stdout or ""),
            stderr=truncate_output(result.stderr or ""),
            exit_code=result.exit_code,
        )
