"""Tests for the ``run_code`` and ``run_command`` execution tools.

Sandboxes are always mocked — no live E2B. Each test constructs a
``SandboxManager`` (patched so ``get()`` returns the mock sandbox), wires the
tool to it, and drives ``run_async`` directly.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from e2b_code_interpreter import CommandExitException

from e2b_adk._results import DEFAULT_MAX_OUTPUT_BYTES
from e2b_adk._sandbox import SandboxManager
from e2b_adk.tools import SUPPORTED_LANGUAGES, RunCode, RunCommand


def _execution(
    *,
    stdout: list[str] | None = None,
    stderr: list[str] | None = None,
    results: list | None = None,
    error: object | None = None,
) -> SimpleNamespace:
    """Build a fake E2B ``Execution`` object."""
    logs = SimpleNamespace(stdout=stdout or [], stderr=stderr or [])
    return SimpleNamespace(logs=logs, results=results or [], error=error)


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
            results=[SimpleNamespace(text="42")],
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
