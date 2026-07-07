"""Tests for :class:`e2b_adk.plugin.E2BPlugin`.

Sandbox creation is always mocked — the plugin must never touch the network at
construction time, and ``close()`` delegates teardown to its ``SandboxManager``.
"""

from __future__ import annotations

import logging
from unittest.mock import AsyncMock, MagicMock

from pytest import LogCaptureFixture

from e2b_adk import E2BPlugin
from e2b_adk._sandbox import SandboxManager


def test_no_sandbox_on_init(patched_create: AsyncMock) -> None:
    E2BPlugin(api_key="test-key", metadata={"example": "x"})

    # Constructing the plugin must not create a sandbox.
    patched_create.assert_not_called()


def test_get_tools_returns_six_shared(patched_create: AsyncMock) -> None:
    plugin = E2BPlugin()

    tools = plugin.get_tools()

    # All six tools are returned...
    names = {tool.name for tool in tools}
    assert names == {
        "run_code",
        "run_command",
        "write_file",
        "read_file",
        "list_files",
        "start_background_command",
    }
    assert len(tools) == 6

    # ...and every tool shares the exact same SandboxManager instance.
    managers = [tool.manager for tool in tools]
    assert all(isinstance(m, SandboxManager) for m in managers)
    assert all(m is managers[0] for m in managers)

    # Still no sandbox created.
    patched_create.assert_not_called()


async def test_close_shuts_down(patched_create: AsyncMock, mock_sandbox: MagicMock) -> None:
    plugin = E2BPlugin()

    # Force a sandbox to exist so close() has something to kill.
    await plugin._manager.get()
    patched_create.assert_awaited_once()

    await plugin.close()

    mock_sandbox.kill.assert_awaited_once()


async def test_close_noop_when_never_created(
    patched_create: AsyncMock, mock_sandbox: MagicMock
) -> None:
    plugin = E2BPlugin()

    # No sandbox ever created — close() is a no-op and must not raise.
    await plugin.close()

    patched_create.assert_not_called()
    mock_sandbox.kill.assert_not_called()


async def test_after_tool_callback_warns_on_failure_result(
    caplog: LogCaptureFixture,
) -> None:
    plugin = E2BPlugin()
    tool = MagicMock(name="tool")
    tool.name = "run_code"

    with caplog.at_level(logging.WARNING, logger="e2b_adk.plugin"):
        out = await plugin.after_tool_callback(
            tool=tool,
            tool_args={},
            tool_context=None,
            result={"success": False, "error": "sandbox unavailable"},
        )

    assert out is None
    assert "returned a failure result" in caplog.text
    assert "sandbox unavailable" in caplog.text


async def test_on_tool_error_callback_logs_and_returns_none(
    caplog: LogCaptureFixture,
) -> None:
    plugin = E2BPlugin()
    tool = MagicMock(name="tool")
    tool.name = "run_command"

    with caplog.at_level(logging.ERROR, logger="e2b_adk.plugin"):
        out = await plugin.on_tool_error_callback(
            tool=tool,
            tool_args={},
            tool_context=None,
            error=RuntimeError("boom"),
        )

    assert out is None
    assert "uncaught exception" in caplog.text


async def test_before_tool_callback_redacts_sensitive_args(
    caplog: LogCaptureFixture,
) -> None:
    plugin = E2BPlugin()
    tool = MagicMock(name="tool")
    tool.name = "write_file"

    with caplog.at_level(logging.DEBUG, logger="e2b_adk.plugin"):
        await plugin.before_tool_callback(
            tool=tool,
            tool_args={
                "path": "/app/main.py",
                "content": "SUPER_SECRET_SOURCE",
                "envs": {"API_TOKEN": "sk-do-not-log"},
            },
            tool_context=None,
        )

    # Secret-prone / large values are masked; harmless args stay for debugging.
    assert "SUPER_SECRET_SOURCE" not in caplog.text
    assert "sk-do-not-log" not in caplog.text
    assert "<redacted>" in caplog.text
    assert "/app/main.py" in caplog.text
