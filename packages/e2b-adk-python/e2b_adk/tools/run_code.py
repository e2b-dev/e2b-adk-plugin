"""``run_code`` — execute a code snippet in the sandbox interpreter."""

from __future__ import annotations

import logging
from typing import Any

from google.adk.tools import BaseTool, ToolContext
from google.genai import types

from .._results import failure_result, success_result, truncate_output
from .._sandbox import SandboxManager
from ._common import SUPPORTED_LANGUAGES, _join, _require_str

logger = logging.getLogger(__name__)


class RunCode(BaseTool):
    """Execute a code snippet inside the E2B sandbox and return its output.

    Backed by ``AsyncSandbox.run_code``. Because the sandbox *runs* the code,
    a snippet that raises still counts as a successful tool call (``success:
    True``) — the raised exception is normalized into the text ``error`` field.
    Only an inability to run the code (sandbox unavailable / create failure /
    timeout) yields ``success: False``.
    """

    def __init__(self, manager: SandboxManager) -> None:
        super().__init__(
            name="run_code",
            description=(
                "Execute a code snippet inside an isolated E2B sandbox and "
                "return its stdout, stderr, the last expression's value, and "
                "any runtime error. Use this to actually run and verify code "
                "rather than only reasoning about it. Defaults to Python."
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
                    "code": types.Schema(
                        type=types.Type.STRING,
                        description="The source code to execute in the sandbox.",
                    ),
                    "language": types.Schema(
                        type=types.Type.STRING,
                        enum=SUPPORTED_LANGUAGES,
                        description=(
                            "Language the code is written in. One of: "
                            f"{', '.join(SUPPORTED_LANGUAGES)}. Optional; "
                            "defaults to 'python' when omitted."
                        ),
                    ),
                    "envs": types.Schema(
                        type=types.Type.OBJECT,
                        description="Optional environment variables for the execution.",
                    ),
                    "timeout": types.Schema(
                        type=types.Type.INTEGER,
                        description="Optional timeout in seconds for the execution.",
                    ),
                },
                required=["code"],
            ),
        )

    async def run_async(
        self, *, args: dict[str, Any], tool_context: ToolContext
    ) -> dict[str, Any]:
        """Execute code inside the E2B sandbox."""
        code = _require_str(args, "code")
        if code is None:
            return failure_result("Missing or invalid required argument: code")
        # Default to Python and normalize case so e.g. "Python" matches E2B's
        # lowercase set. Guard against a null / non-string arg so normalization
        # never raises out of run_async (which would abort the agent run).
        raw_language = args.get("language") or "python"
        language: str = raw_language.lower() if isinstance(raw_language, str) else "python"
        envs: dict[str, str] | None = args.get("envs")
        timeout: int | None = args.get("timeout")

        try:
            sandbox = await self.manager.get()
        except Exception as exc:  # noqa: BLE001 — never raise out of run_async
            logger.debug("run_code: sandbox unavailable: %s", exc)
            return failure_result(f"Sandbox unavailable: {exc}")

        try:
            # E2B runs every supported language through this single call, so
            # there is no per-language branching.
            async with self.manager.keep_alive(sandbox):
                execution = await sandbox.run_code(
                    code,
                    language=language,
                    envs=envs,
                    timeout=timeout,
                )
        except Exception as exc:  # noqa: BLE001 — SDK/timeout failure → success:false
            logger.debug("run_code: execution could not run: %s", exc)
            return failure_result(f"Failed to run code: {exc}")

        stdout = truncate_output(_join(execution.logs.stdout))
        stderr = truncate_output(_join(execution.logs.stderr))

        # execution.text is the main-result text (the last expression's value),
        # not merely the first result — which may be a display output (chart,
        # rich repr) rather than the return value. None when there is no result.
        text = truncate_output(execution.text or "")

        error = ""
        if execution.error is not None:
            err = execution.error
            error = truncate_output(
                f"{err.name}: {err.value}\n{err.traceback}"
            )

        return success_result(
            stdout=stdout,
            stderr=stderr,
            text=text,
            error=error,
        )
