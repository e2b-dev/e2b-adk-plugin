"""``read_file`` — read a file from the sandbox filesystem."""

from __future__ import annotations

import logging
from typing import Any

from google.adk.tools import BaseTool, ToolContext
from google.genai import types

from .._results import failure_result, success_result, truncate_output
from .._sandbox import SandboxManager
from ._common import _require_str

logger = logging.getLogger(__name__)


class ReadFile(BaseTool):
    """Read a text file from the E2B sandbox filesystem.

    Backed by ``AsyncSandbox.files.read`` (text format). A missing file, an
    unavailable sandbox, or an SDK error yields ``success: False`` with the
    echoed ``path``; the returned ``content`` is truncated per the result
    contract so a large file cannot exhaust the agent's context window.
    """

    def __init__(self, manager: SandboxManager) -> None:
        super().__init__(
            name="read_file",
            description=(
                "Read a text file from an isolated E2B sandbox at the given "
                "path and return its content. Use this to inspect files the "
                "sandbox produced or that you wrote earlier."
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
                    "path": types.Schema(
                        type=types.Type.STRING,
                        description="Path of the file to read from the sandbox.",
                    ),
                },
                required=["path"],
            ),
        )

    async def run_async(
        self, *, args: dict[str, Any], tool_context: ToolContext
    ) -> dict[str, Any]:
        path = _require_str(args, "path")
        if path is None:
            return failure_result("Missing or invalid required argument: path")

        try:
            sandbox = await self.manager.get()
        except Exception as exc:  # noqa: BLE001 — never raise out of run_async
            logger.debug("read_file: sandbox unavailable: %s", exc)
            return failure_result(f"Sandbox unavailable: {exc}", path=path)

        try:
            content = await sandbox.files.read(path)
        except Exception as exc:  # noqa: BLE001 — missing/SDK failure → success:false
            logger.debug("read_file: could not read %s: %s", path, exc)
            return failure_result(f"Failed to read file: {exc}", path=path)

        return success_result(path=path, content=truncate_output(content or ""))
