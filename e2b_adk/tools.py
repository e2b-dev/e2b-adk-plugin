"""ADK ``BaseTool`` subclasses that execute inside the E2B sandbox.

Two execution tools land here:

* ``RunCode`` (``run_code``) — run a code snippet in the sandbox interpreter.
* ``RunCommand`` (``run_command``) — run a shell command in the sandbox.

Both follow the single result contract from :mod:`e2b_adk._results`:

* The tool *ran* (even if the user's code raised or the command exited
  non-zero) → ``success: True`` with the captured output / normalized error.
* The tool *could not run* (sandbox unavailable, create failure, timeout) →
  ``success: False`` with an ``error`` and any ``partial_output``.

Failures are always **returned**, never raised out of ``run_async`` — a raised
exception would abort the whole agent run.
"""

from __future__ import annotations

import logging
from typing import Any, get_args

from e2b_code_interpreter import CommandExitException, RunCodeLanguage
from google.adk.tools import BaseTool, ToolContext
from google.genai import types

from ._results import failure_result, success_result, truncate_output
from ._sandbox import SandboxManager

logger = logging.getLogger(__name__)


def _supported_languages() -> list[str]:
    """Derive the known languages from E2B's ``RunCodeLanguage`` type alias.

    E2B declares it as ``Union[Literal["python", ...], str]`` — an *open* union
    (any string is accepted; the literals are the known set). We unpack those
    literal members so the enum we advertise stays in lockstep with the pinned
    SDK and is never maintained in two places. Falls back to ``["python"]`` if
    the alias shape ever changes (``run_code`` still accepts any string).
    """
    args = get_args(RunCodeLanguage)
    # Bare ``Literal["python", ...]`` → args are the strings themselves.
    if args and all(isinstance(a, str) for a in args):
        return list(args)
    # ``Union[Literal[...], str]`` → find the Literal member and unpack it.
    for arg in args:
        members = get_args(arg)
        if members and all(isinstance(m, str) for m in members):
            return list(members)
    return ["python"]


#: Languages E2B's ``run_code`` supports natively, sourced from the SDK's own
#: ``RunCodeLanguage``. E2B runs all of them through a single ``run_code`` call,
#: so this tool needs no per-language branching.
SUPPORTED_LANGUAGES = _supported_languages()


def _join(chunks: list[str] | None) -> str:
    """Join a list of E2B log chunks into a single text blob.

    E2B ``Logs.stdout`` / ``Logs.stderr`` are lists of chunks whose entries
    already carry their own newlines, so they are concatenated with no
    separator to avoid doubling line breaks. ``None`` collapses to ``""``.
    """
    if not chunks:
        return ""
    return "".join(chunks)


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
        code: str = args["code"]
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
            logger.warning("run_code: sandbox unavailable: %s", exc)
            return failure_result(f"Sandbox unavailable: {exc}")

        try:
            # E2B runs every supported language through this single call, so
            # there is no per-language branching.
            execution = await sandbox.run_code(
                code,
                language=language,
                envs=envs,
                timeout=timeout,
            )
        except Exception as exc:  # noqa: BLE001 — SDK/timeout failure → success:false
            logger.warning("run_code: execution could not run: %s", exc)
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
        command: str = args["command"]
        cwd: str | None = args.get("cwd")
        envs: dict[str, str] | None = args.get("envs")
        timeout: int | None = args.get("timeout")

        try:
            sandbox = await self.manager.get()
        except Exception as exc:  # noqa: BLE001 — never raise out of run_async
            logger.warning("run_command: sandbox unavailable: %s", exc)
            return failure_result(f"Sandbox unavailable: {exc}", command=command)

        run_kwargs: dict[str, Any] = {"cwd": cwd, "envs": envs}
        if timeout is not None:
            run_kwargs["timeout"] = timeout

        try:
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
            logger.warning("run_command: command could not run: %s", exc)
            return failure_result(f"Failed to run command: {exc}", command=command)

        return success_result(
            command=command,
            stdout=truncate_output(result.stdout or ""),
            stderr=truncate_output(result.stderr or ""),
            exit_code=result.exit_code,
        )
