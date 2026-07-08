"""ADK ``BaseTool`` subclasses that execute inside the E2B sandbox.

The tools land here:

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

import logging
from typing import Any, get_args

from e2b_code_interpreter import CommandExitException, FileType, RunCodeLanguage
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


def _normalize_type(file_type: FileType | None) -> str:
    """Normalize an E2B ``FileType`` entry to a plain string.

    ``FileType.FILE`` / ``FileType.DIR`` map to their ``.value`` (``"file"`` /
    ``"dir"``). A ``None`` type (E2B may omit it for an entry it cannot classify)
    collapses to ``"unknown"`` so every entry carries a JSON-friendly string
    ``type`` and callers never have to handle ``None``.
    """
    if file_type is None:
        return "unknown"
    return str(file_type.value)


def _require_str(args: dict[str, Any], key: str, *, allow_empty: bool = False) -> str | None:
    """Return ``args[key]`` when it is a valid string, else ``None``.

    Guards a *required* argument so a malformed tool call (a missing or
    non-string value) is turned into a returned failure rather than a ``KeyError``
    raised out of ``run_async`` — the tools must never raise. ``allow_empty=True``
    permits ``""`` (e.g. writing an empty file); otherwise an empty string is
    rejected like a missing value.
    """
    value = args.get(key)
    if not isinstance(value, str):
        return None
    if not value and not allow_empty:
        return None
    return value


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
            await sandbox.files.write(path, content)
        except Exception as exc:  # noqa: BLE001 — SDK/path failure → success:false
            logger.debug("write_file: could not write %s: %s", path, exc)
            return failure_result(f"Failed to write file: {exc}", path=path)

        return success_result(path=path)


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


class StartBackgroundCommand(BaseTool):
    """Start a long-running command in the E2B sandbox and return immediately.

    Backed by ``AsyncSandbox.commands.run(..., background=True)``, which returns
    an ``AsyncCommandHandle`` right away; this tool reports its ``pid`` without
    waiting for the process to become ready. Marked ``is_long_running=True`` so
    ADK treats it as a fire-and-return call.

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
            is_long_running=True,
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
        port: int | None = args.get("port")
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
