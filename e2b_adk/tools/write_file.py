"""``write_file`` — write a file into the sandbox filesystem."""

from __future__ import annotations

import logging
from typing import Any

from google.adk.tools import BaseTool, ToolContext
from google.genai import types

from .._results import failure_result, success_result
from .._sandbox import SandboxManager
from ._common import _require_str

logger = logging.getLogger(__name__)


class WriteFile(BaseTool):
    """Write a file into the E2B sandbox filesystem.

    Backed by ``AsyncSandbox.files.write``. The write *running* — even to an
    existing file, which it overwrites — is a successful tool call. Only an
    inability to write (sandbox unavailable, non-writable / invalid path, SDK
    error) yields ``success: False`` with the echoed ``path``.
    """

    def __init__(self, manager: SandboxManager) -> None:
        super().__init__(
            name="write_file",
            description=(
                "Write a text file into an isolated E2B sandbox at the given "
                "path, creating or overwriting it. Use this to place source "
                "files, configs, or data into the sandbox before running them."
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
                        description="Destination path for the file in the sandbox.",
                    ),
                    "content": types.Schema(
                        type=types.Type.STRING,
                        description="The text content to write to the file.",
                    ),
                },
                required=["path", "content"],
            ),
        )

    async def run_async(
        self, *, args: dict[str, Any], tool_context: ToolContext
    ) -> dict[str, Any]:
        path = _require_str(args, "path")
        if path is None:
            return failure_result("Missing or invalid required argument: path")
        content = _require_str(args, "content", allow_empty=True)
        if content is None:
            return failure_result(
                "Missing or invalid required argument: content", path=path
            )

        try:
            sandbox = await self.manager.get()
        except Exception as exc:  # noqa: BLE001 — never raise out of run_async
            logger.debug("write_file: sandbox unavailable: %s", exc)
            return failure_result(f"Sandbox unavailable: {exc}", path=path)

        try:
            async with self.manager.keep_alive(sandbox):
                await sandbox.files.write(path, content)
        except Exception as exc:  # noqa: BLE001 — SDK/path failure → success:false
            logger.debug("write_file: could not write %s: %s", path, exc)
            return failure_result(f"Failed to write file: {exc}", path=path)

        return success_result(path=path)
