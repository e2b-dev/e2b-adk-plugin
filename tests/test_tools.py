"""Tests for the ``run_code`` and ``run_command`` execution tools.

Sandboxes are always mocked — no live E2B. Each test constructs a
``SandboxManager`` (patched so ``get()`` returns the mock sandbox), wires the
tool to it, and drives ``run_async`` directly.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from e2b_code_interpreter import CommandExitException, FileType

from e2b_adk._results import DEFAULT_MAX_OUTPUT_BYTES
from e2b_adk._sandbox import SandboxManager
from e2b_adk.tools import (
    SUPPORTED_LANGUAGES,
    ListFiles,
    ReadFile,
    RunCode,
    RunCommand,
    StartBackgroundCommand,
    WriteFile,
)


def _execution(
    *,
    stdout: list[str] | None = None,
    stderr: list[str] | None = None,
    text: str | None = None,
    error: object | None = None,
) -> SimpleNamespace:
    """Build a fake E2B ``Execution``.

    ``text`` mirrors the real ``Execution.text`` property (the main-result
    value), which is what the tool reads.
    """
    logs = SimpleNamespace(stdout=stdout or [], stderr=stderr or [])
    return SimpleNamespace(logs=logs, text=text, error=error)


def _make_run_code(mock_sandbox: MagicMock) -> RunCode:
    manager = SandboxManager()
    manager._sandbox = mock_sandbox  # pre-seed the cache to skip create()
    return RunCode(manager)


def _make_run_command(mock_sandbox: MagicMock) -> RunCommand:
    manager = SandboxManager()
    manager._sandbox = mock_sandbox
    return RunCommand(manager)


# --------------------------------------------------------------------------- #
# run_code
# --------------------------------------------------------------------------- #


async def test_run_code_success(mock_sandbox: MagicMock) -> None:
    mock_sandbox.run_code = AsyncMock(
        return_value=_execution(
            stdout=["hello\n", "world\n"],
            stderr=["warn\n"],
            text="42",
            error=None,
        )
    )
    tool = _make_run_code(mock_sandbox)

    result = await tool.run_async(args={"code": "print('hi')"}, tool_context=None)

    assert result["success"] is True
    assert result["stdout"] == "hello\nworld\n"
    assert result["stderr"] == "warn\n"
    assert result["text"] == "42"
    assert result["error"] == ""


async def test_run_code_traceback_normalized(mock_sandbox: MagicMock) -> None:
    err = SimpleNamespace(
        name="ValueError",
        value="bad input",
        traceback="Traceback (most recent call last):\n  ...\nValueError: bad input",
    )
    mock_sandbox.run_code = AsyncMock(
        return_value=_execution(stdout=["partial\n"], error=err)
    )
    tool = _make_run_code(mock_sandbox)

    result = await tool.run_async(args={"code": "raise ValueError('bad input')"}, tool_context=None)

    # Code ran-but-errored → success stays true, error carries normalized text.
    assert result["success"] is True
    assert "ValueError" in result["error"]
    assert "bad input" in result["error"]
    assert "Traceback" in result["error"]
    assert result["stdout"] == "partial\n"


async def test_run_code_sandbox_unavailable(mock_sandbox: MagicMock) -> None:
    manager = SandboxManager()
    manager.get = AsyncMock(side_effect=RuntimeError("no sandbox"))  # type: ignore[method-assign]
    tool = RunCode(manager)

    result = await tool.run_async(args={"code": "print(1)"}, tool_context=None)

    assert result["success"] is False
    assert "no sandbox" in result["error"]
    # Never raised — a dict was returned.
    assert isinstance(result, dict)


async def test_run_code_truncates_output(mock_sandbox: MagicMock) -> None:
    big = "x" * (DEFAULT_MAX_OUTPUT_BYTES + 5_000)
    mock_sandbox.run_code = AsyncMock(
        return_value=_execution(stdout=[big], error=None)
    )
    tool = _make_run_code(mock_sandbox)

    result = await tool.run_async(args={"code": "print('x' * 15000)"}, tool_context=None)

    assert result["success"] is True
    assert "…[truncated" in result["stdout"]
    assert len(result["stdout"].encode("utf-8")) < len(big.encode("utf-8"))


def test_run_code_declaration_language_enum(mock_sandbox: MagicMock) -> None:
    # The schema advertises E2B's supported languages so the model picks a valid
    # one (not a copy of another SDK's narrower/absent set).
    tool = _make_run_code(mock_sandbox)
    decl = tool._get_declaration()
    lang_schema = decl.parameters.properties["language"]
    assert lang_schema.enum == SUPPORTED_LANGUAGES
    assert "python" in lang_schema.enum and "bash" in lang_schema.enum


async def test_run_code_language_lowercased(mock_sandbox: MagicMock) -> None:
    # A mixed-case language from the model is normalized to E2B's lowercase form.
    mock_sandbox.run_code = AsyncMock(return_value=_execution(error=None))
    tool = _make_run_code(mock_sandbox)

    await tool.run_async(
        args={"code": "console.log(1)", "language": "JavaScript"}, tool_context=None
    )

    assert mock_sandbox.run_code.await_args.kwargs["language"] == "javascript"


async def test_run_code_null_language_defaults_without_raising(
    mock_sandbox: MagicMock,
) -> None:
    # A null language (or a non-string) must not raise out of run_async; it
    # falls back to python so the agent run is never aborted.
    mock_sandbox.run_code = AsyncMock(return_value=_execution(error=None))
    tool = _make_run_code(mock_sandbox)

    result = await tool.run_async(
        args={"code": "print(1)", "language": None}, tool_context=None
    )

    assert result["success"] is True
    assert mock_sandbox.run_code.await_args.kwargs["language"] == "python"


# --------------------------------------------------------------------------- #
# run_command
# --------------------------------------------------------------------------- #


async def test_run_command_success(mock_sandbox: MagicMock) -> None:
    mock_sandbox.commands = MagicMock()
    mock_sandbox.commands.run = AsyncMock(
        return_value=SimpleNamespace(
            stdout="ok\n", stderr="", exit_code=0, error=None
        )
    )
    tool = _make_run_command(mock_sandbox)

    result = await tool.run_async(args={"command": "echo ok"}, tool_context=None)

    assert result["success"] is True
    assert result["stdout"] == "ok\n"
    assert result["stderr"] == ""
    assert result["exit_code"] == 0
    assert result["command"] == "echo ok"


async def test_run_command_nonzero_exit_caught(mock_sandbox: MagicMock) -> None:
    exc = CommandExitException(
        stdout="some out",
        stderr="boom",
        exit_code=2,
        error=None,
    )
    mock_sandbox.commands = MagicMock()
    mock_sandbox.commands.run = AsyncMock(side_effect=exc)
    tool = _make_run_command(mock_sandbox)

    result = await tool.run_async(args={"command": "false"}, tool_context=None)

    # Command ran but exited non-zero → success:true, no raise.
    assert result["success"] is True
    assert result["exit_code"] == 2
    assert result["stdout"] == "some out"
    assert result["stderr"] == "boom"


async def test_run_command_failure_paths(mock_sandbox: MagicMock) -> None:
    # Sandbox unavailable → success:false + error.
    manager = SandboxManager()
    manager.get = AsyncMock(side_effect=RuntimeError("no sandbox"))  # type: ignore[method-assign]
    unavailable_tool = RunCommand(manager)
    unavailable = await unavailable_tool.run_async(
        args={"command": "ls"}, tool_context=None
    )
    assert unavailable["success"] is False
    assert "no sandbox" in unavailable["error"]
    assert unavailable["command"] == "ls"

    # Timeout → success:false + partial_output present.
    mock_sandbox.commands = MagicMock()
    mock_sandbox.commands.run = AsyncMock(side_effect=TimeoutError("command timeout"))
    timeout_tool = _make_run_command(mock_sandbox)
    timed_out = await timeout_tool.run_async(args={"command": "sleep 999"}, tool_context=None)
    assert timed_out["success"] is False
    assert "timeout" in timed_out["error"].lower()
    assert "partial_output" in timed_out


# --------------------------------------------------------------------------- #
# file-tool helpers
# --------------------------------------------------------------------------- #


def _make_write_file(mock_sandbox: MagicMock) -> WriteFile:
    manager = SandboxManager()
    manager._sandbox = mock_sandbox
    return WriteFile(manager)


def _make_read_file(mock_sandbox: MagicMock) -> ReadFile:
    manager = SandboxManager()
    manager._sandbox = mock_sandbox
    return ReadFile(manager)


def _make_list_files(mock_sandbox: MagicMock) -> ListFiles:
    manager = SandboxManager()
    manager._sandbox = mock_sandbox
    return ListFiles(manager)


def _make_background(mock_sandbox: MagicMock) -> StartBackgroundCommand:
    manager = SandboxManager()
    manager._sandbox = mock_sandbox
    return StartBackgroundCommand(manager)


# --------------------------------------------------------------------------- #
# write_file + read_file
# --------------------------------------------------------------------------- #


async def test_write_then_read_roundtrip(mock_sandbox: MagicMock) -> None:
    # A tiny in-memory FS backs the mocked write/read so the roundtrip is real.
    store: dict[str, str] = {}
    mock_sandbox.files = MagicMock()

    async def _write(path: str, data: str) -> object:
        store[path] = data
        return SimpleNamespace(path=path, name=path)

    async def _read(path: str) -> str:
        return store[path]

    mock_sandbox.files.write = AsyncMock(side_effect=_write)
    mock_sandbox.files.read = AsyncMock(side_effect=_read)

    write_tool = _make_write_file(mock_sandbox)
    read_tool = _make_read_file(mock_sandbox)

    write_result = await write_tool.run_async(
        args={"path": "/tmp/note.txt", "content": "hello"}, tool_context=None
    )
    assert write_result["success"] is True
    assert write_result["path"] == "/tmp/note.txt"

    read_result = await read_tool.run_async(
        args={"path": "/tmp/note.txt"}, tool_context=None
    )
    assert read_result["success"] is True
    assert read_result["path"] == "/tmp/note.txt"
    assert read_result["content"] == "hello"


async def test_read_missing_file(mock_sandbox: MagicMock) -> None:
    mock_sandbox.files = MagicMock()
    mock_sandbox.files.read = AsyncMock(
        side_effect=FileNotFoundError("path not found: /nope.txt")
    )
    tool = _make_read_file(mock_sandbox)

    result = await tool.run_async(args={"path": "/nope.txt"}, tool_context=None)

    assert result["success"] is False
    assert "not found" in result["error"].lower()
    assert result["path"] == "/nope.txt"
    assert isinstance(result, dict)  # never raised


async def test_write_bad_path(mock_sandbox: MagicMock) -> None:
    mock_sandbox.files = MagicMock()
    mock_sandbox.files.write = AsyncMock(
        side_effect=PermissionError("permission denied: /root/x")
    )
    tool = _make_write_file(mock_sandbox)

    result = await tool.run_async(
        args={"path": "/root/x", "content": "data"}, tool_context=None
    )

    assert result["success"] is False
    assert "permission denied" in result["error"].lower()
    assert result["path"] == "/root/x"


async def test_read_truncates(mock_sandbox: MagicMock) -> None:
    big = "y" * (DEFAULT_MAX_OUTPUT_BYTES + 5_000)
    mock_sandbox.files = MagicMock()
    mock_sandbox.files.read = AsyncMock(return_value=big)
    tool = _make_read_file(mock_sandbox)

    result = await tool.run_async(args={"path": "/big.txt"}, tool_context=None)

    assert result["success"] is True
    assert "…[truncated" in result["content"]
    assert len(result["content"].encode("utf-8")) < len(big.encode("utf-8"))


# --------------------------------------------------------------------------- #
# list_files
# --------------------------------------------------------------------------- #


async def test_list_files_entries(mock_sandbox: MagicMock) -> None:
    entries = [
        SimpleNamespace(name="app.py", type=FileType.FILE),
        SimpleNamespace(name="src", type=FileType.DIR),
    ]
    mock_sandbox.files = MagicMock()
    mock_sandbox.files.list = AsyncMock(return_value=entries)
    tool = _make_list_files(mock_sandbox)

    result = await tool.run_async(args={"path": "/proj"}, tool_context=None)

    assert result["success"] is True
    assert result["path"] == "/proj"
    assert result["entries"] == [
        {"name": "app.py", "type": "file"},
        {"name": "src", "type": "dir"},
    ]


async def test_list_files_type_mapping(mock_sandbox: MagicMock) -> None:
    # FileType enum members AND a None type must all normalize to strings.
    entries = [
        SimpleNamespace(name="f", type=FileType.FILE),
        SimpleNamespace(name="d", type=FileType.DIR),
        SimpleNamespace(name="mystery", type=None),
    ]
    mock_sandbox.files = MagicMock()
    mock_sandbox.files.list = AsyncMock(return_value=entries)
    tool = _make_list_files(mock_sandbox)

    result = await tool.run_async(args={"path": "."}, tool_context=None)

    types = {e["name"]: e["type"] for e in result["entries"]}
    assert types["f"] == "file"
    assert types["d"] == "dir"
    assert types["mystery"] == "unknown"
    assert all(isinstance(e["type"], str) for e in result["entries"])


async def test_list_files_default_path(mock_sandbox: MagicMock) -> None:
    mock_sandbox.files = MagicMock()
    mock_sandbox.files.list = AsyncMock(return_value=[])
    tool = _make_list_files(mock_sandbox)

    result = await tool.run_async(args={}, tool_context=None)

    assert result["success"] is True
    assert result["path"] == "."
    assert mock_sandbox.files.list.await_args.args[0] == "."


async def test_list_missing_dir(mock_sandbox: MagicMock) -> None:
    mock_sandbox.files = MagicMock()
    mock_sandbox.files.list = AsyncMock(
        side_effect=FileNotFoundError("directory does not exist: /nope")
    )
    tool = _make_list_files(mock_sandbox)

    result = await tool.run_async(args={"path": "/nope"}, tool_context=None)

    assert result["success"] is False
    assert result["path"] == "/nope"
    assert isinstance(result, dict)  # never raised


# --------------------------------------------------------------------------- #
# start_background_command
# --------------------------------------------------------------------------- #


async def test_background_with_port(mock_sandbox: MagicMock) -> None:
    mock_sandbox.commands = MagicMock()
    mock_sandbox.commands.run = AsyncMock(return_value=SimpleNamespace(pid=4321))
    mock_sandbox.get_host = MagicMock(return_value="3000-sbx_test_123.e2b.app")
    tool = _make_background(mock_sandbox)

    result = await tool.run_async(
        args={"command": "python -m http.server 3000", "port": 3000},
        tool_context=None,
    )

    assert result["success"] is True
    assert result["pid"] == 4321
    assert result["preview_url"] == "https://3000-sbx_test_123.e2b.app"
    assert result["readiness"] == "unknown"
    # get_host is synchronous (called, not awaited) and background=True was set.
    mock_sandbox.get_host.assert_called_once_with(3000)
    assert mock_sandbox.commands.run.await_args.kwargs["background"] is True


async def test_background_without_port(mock_sandbox: MagicMock) -> None:
    mock_sandbox.commands = MagicMock()
    mock_sandbox.commands.run = AsyncMock(return_value=SimpleNamespace(pid=99))
    mock_sandbox.get_host = MagicMock()
    tool = _make_background(mock_sandbox)

    result = await tool.run_async(args={"command": "sleep 100"}, tool_context=None)

    assert result["success"] is True
    assert result["pid"] == 99
    # No port → no preview URL (explicitly None) and get_host untouched.
    assert result.get("preview_url") is None
    mock_sandbox.get_host.assert_not_called()


async def test_background_start_failure(mock_sandbox: MagicMock) -> None:
    mock_sandbox.commands = MagicMock()
    mock_sandbox.commands.run = AsyncMock(
        side_effect=RuntimeError("could not spawn process")
    )
    tool = _make_background(mock_sandbox)

    result = await tool.run_async(
        args={"command": "bad-cmd", "port": 8080}, tool_context=None
    )

    assert result["success"] is False
    assert "could not spawn" in result["error"].lower()
    assert result["command"] == "bad-cmd"
    assert isinstance(result, dict)  # never raised


def test_background_is_long_running(mock_sandbox: MagicMock) -> None:
    tool = _make_background(mock_sandbox)
    assert tool.is_long_running is True


async def test_background_get_host_failure_degrades(mock_sandbox: MagicMock) -> None:
    # The command started (we have its pid); a get_host failure must NOT raise and
    # must NOT lose the pid — it degrades to no preview URL.
    mock_sandbox.commands = MagicMock()
    mock_sandbox.commands.run = AsyncMock(return_value=SimpleNamespace(pid=777))
    mock_sandbox.get_host = MagicMock(side_effect=RuntimeError("no host"))
    tool = _make_background(mock_sandbox)

    result = await tool.run_async(
        args={"command": "python -m http.server 3000", "port": 3000},
        tool_context=None,
    )

    assert result["success"] is True  # the command did start
    assert result["pid"] == 777
    assert result.get("preview_url") is None
    assert result["readiness"] == "unknown"
    assert isinstance(result, dict)  # never raised


# --------------------------------------------------------------------------- #
# Malformed args must never raise out of run_async (return a failure result).
# --------------------------------------------------------------------------- #


async def test_missing_required_args_never_raise(mock_sandbox: MagicMock) -> None:
    # Each tool indexes required args; a malformed call (missing them) must return
    # a failure dict, never raise a KeyError out of run_async.
    cases = [
        (_make_run_code(mock_sandbox), {}),  # no "code"
        (_make_run_command(mock_sandbox), {}),  # no "command"
        (_make_write_file(mock_sandbox), {"content": "x"}),  # no "path"
        (_make_read_file(mock_sandbox), {}),  # no "path"
        (_make_background(mock_sandbox), {"port": 8080}),  # no "command"
    ]
    for tool, bad_args in cases:
        result = await tool.run_async(args=bad_args, tool_context=None)
        assert isinstance(result, dict), f"{tool.name} raised instead of returning"
        assert result["success"] is False
        assert "required argument" in result["error"].lower()


async def test_write_file_allows_empty_content(mock_sandbox: MagicMock) -> None:
    # An empty string is a valid file body — the required-arg guard must allow it.
    written: dict[str, str] = {}
    mock_sandbox.files = MagicMock()

    async def _write(path: str, data: str) -> object:
        written[path] = data
        return SimpleNamespace(path=path)

    mock_sandbox.files.write = AsyncMock(side_effect=_write)
    tool = _make_write_file(mock_sandbox)

    result = await tool.run_async(
        args={"path": "/empty.txt", "content": ""}, tool_context=None
    )

    assert result["success"] is True
    assert written["/empty.txt"] == ""
