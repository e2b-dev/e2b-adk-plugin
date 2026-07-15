"""``list_files`` — list a directory in the sandbox filesystem."""

from __future__ import annotations

import logging
from typing import Any

from google.adk.tools import BaseTool, ToolContext
from google.genai import types

from .._results import failure_result, success_result
from .._sandbox import SandboxManager
from ._common import _normalize_type

logger = logging.getLogger(__name__)


class ListFiles(BaseTool):
    """List a directory in the E2B sandbox filesystem.

    Backed by ``AsyncSandbox.files.list``. Returns one ``entries`` element per
    child, each ``{"name": ..., "type": ...}`` where ``type`` is the normalized
    string ``"file"`` / ``"dir"`` (or ``"unknown"`` when E2B omits it). A
    non-existent directory or SDK error yields ``success: False`` with the
    echoed ``path``.
    """

    def __init__(self, manager: SandboxManager) -> None:
        super().__init__(
            name="list_files",
            description=(
                "List the entries of a directory in an isolated E2B sandbox. "
                "Returns each child's name and type (file or dir). Defaults to "
                "the current directory. Use this to explore the sandbox "
                "filesystem."
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
                        description=(
                            "Directory to list in the sandbox. Optional; "
                            "defaults to '.' (the current directory)."
                        ),
                    ),
                },
            ),
        )

    async def run_async(
        self, *, args: dict[str, Any], tool_context: ToolContext
    ) -> dict[str, Any]:
        path: str = args.get("path") or "."

        try:
            sandbox = await self.manager.get()
        except Exception as exc:  # noqa: BLE001 — never raise out of run_async
            logger.debug("list_files: sandbox unavailable: %s", exc)
            return failure_result(f"Sandbox unavailable: {exc}", path=path)

        try:
            async with self.manager.keep_alive(sandbox):
                entries = await sandbox.files.list(path)
        except Exception as exc:  # noqa: BLE001 — missing dir/SDK failure → success:false
            logger.debug("list_files: could not list %s: %s", path, exc)
            return failure_result(f"Failed to list directory: {exc}", path=path)

        return success_result(
            path=path,
            entries=[
                {"name": entry.name, "type": _normalize_type(entry.type)}
                for entry in entries
            ],
        )
