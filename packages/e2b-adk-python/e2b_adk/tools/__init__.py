"""ADK ``BaseTool`` subclasses that execute inside the E2B sandbox.

One tool per module, re-exported here so ``from e2b_adk.tools import RunCode``
(and the plugin's own imports) keep working. The tools:

* ``RunCode`` (``run_code``) — run a code snippet in the sandbox interpreter.
* ``RunCommand`` (``run_command``) — run a shell command in the sandbox.
* ``WriteFile`` (``write_file``) — write a file into the sandbox filesystem.
* ``ReadFile`` (``read_file``) — read a file from the sandbox filesystem.
* ``ListFiles`` (``list_files``) — list a directory in the sandbox filesystem.
* ``StartBackgroundCommand`` (``start_background_command``) — start a
  long-running command (e.g. a dev server) and return immediately.

All follow the single result contract from :mod:`e2b_adk._results`:

* The tool *ran* (even if the user's code raised or the command exited
  non-zero) → ``success: True`` with the captured output / normalized error.
* The tool *could not run* (sandbox unavailable, create failure, timeout) →
  ``success: False`` with an ``error`` and any ``partial_output``.

Failures are always **returned**, never raised out of ``run_async`` — a raised
exception would abort the whole agent run.
"""

from __future__ import annotations

from ._common import SUPPORTED_LANGUAGES
from .list_files import ListFiles
from .read_file import ReadFile
from .run_code import RunCode
from .run_command import RunCommand
from .start_background_command import StartBackgroundCommand
from .write_file import WriteFile

__all__ = [
    "SUPPORTED_LANGUAGES",
    "ListFiles",
    "ReadFile",
    "RunCode",
    "RunCommand",
    "StartBackgroundCommand",
    "WriteFile",
]
