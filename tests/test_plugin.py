"""Tests for :class:`e2b_adk.plugin.E2BPlugin`.

Sandbox creation is always mocked — the plugin must never touch the network at
construction time, and ``close()`` delegates teardown to its ``SandboxManager``.
"""

from __future__ import annotations

import inspect
import logging
from unittest.mock import AsyncMock, MagicMock

from e2b.connection_config import ApiParams
from e2b_code_interpreter import AsyncSandbox
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


def test_forwarded_opts_accepted_by_sdk_create() -> None:
    # SDK-drift guard. Every option the plugin forwards must be either a named
    # AsyncSandbox.create parameter or a declared ApiParams key (create's
    # `**opts: Unpack[ApiParams]` channel — where api_key lives).
    #
    # We deliberately do NOT accept "create has **kwargs" as sufficient: at
    # runtime `**opts` silently swallows any keyword, so if E2B renamed a param
    # (e.g. `lifecycle` -> `sandbox_lifecycle`) our forwarded key would be
    # accepted-and-ignored rather than raising. Validating against the *named
    # params + the ApiParams TypedDict* is the real contract and catches that
    # rename statically. Construction is lazy, so no sandbox is created.
    plugin = E2BPlugin(
        api_key="k",
        template="t",
        metadata={"a": "b"},
        envs={"E": "1"},
        timeout=30,
        secure=True,
        allow_internet_access=True,
        mcp={},
        network={},
        lifecycle={"on_timeout": "kill"},
        volume_mounts={},
    )

    params = inspect.signature(AsyncSandbox.create).parameters
    named = {
        name
        for name, p in params.items()
        if p.kind is not inspect.Parameter.VAR_KEYWORD and name != "cls"
    }
    api_params_keys = set(ApiParams.__annotations__)
    allowed = named | api_params_keys

    forwarded = set(plugin._manager._opts)
    # Every non-None constructor option must have reached the manager.
    assert forwarded == {
        "api_key",
        "template",
        "metadata",
        "envs",
        "timeout",
        "secure",
        "allow_internet_access",
        "mcp",
        "network",
        "lifecycle",
        "volume_mounts",
    }
    unknown = forwarded - allowed
    assert not unknown, f"create() no longer accepts forwarded opt(s): {unknown}"
    # api_key specifically must remain an ApiParams member, not just tolerated.
    assert "api_key" in api_params_keys


def test_extra_kwargs_forwarded_verbatim() -> None:
    # The **opts catch-all lets connection-level ApiParams (and any future
    # create() param) through without a plugin change — e.g. proxy / request
    # timeout for enterprise/self-hosted setups. Construction stays lazy.
    plugin = E2BPlugin(
        template="t",
        proxy="http://proxy.internal:8080",
        request_timeout=30.0,
    )

    opts = plugin._manager._opts
    assert opts["proxy"] == "http://proxy.internal:8080"
    assert opts["request_timeout"] == 30.0
    assert opts["template"] == "t"


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
    tool.manager = plugin._manager  # one of this plugin's own tools

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
    tool.manager = plugin._manager  # one of this plugin's own tools

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
    tool.manager = plugin._manager  # one of this plugin's own tools

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


async def test_callbacks_ignore_foreign_tools(caplog: LogCaptureFixture) -> None:
    # ADK dispatches plugin callbacks for every tool in the app; tools this
    # plugin doesn't own must produce no "E2B tool" logs or warnings.
    plugin = E2BPlugin()
    foreign = MagicMock(name="foreign_tool")
    foreign.name = "someone_elses_tool"
    foreign.manager = object()  # not this plugin's SandboxManager

    # A typical ADK tool has no `manager` attribute at all (e.g. FunctionTool):
    # the spec-limited mock raises AttributeError on .manager access, so the
    # ownership check must treat it as foreign rather than blow up.
    managerless = MagicMock(name="managerless_tool", spec=["name"])
    managerless.name = "plain_function_tool"

    with caplog.at_level(logging.DEBUG, logger="e2b_adk.plugin"):
        assert (
            await plugin.before_tool_callback(
                tool=managerless, tool_args={}, tool_context=None
            )
            is None
        )
        assert (
            await plugin.before_tool_callback(
                tool=foreign, tool_args={"x": 1}, tool_context=None
            )
            is None
        )
        assert (
            await plugin.after_tool_callback(
                tool=foreign,
                tool_args={},
                tool_context=None,
                result={"success": False, "error": "their own convention"},
            )
            is None
        )
        assert (
            await plugin.on_tool_error_callback(
                tool=foreign, tool_args={}, tool_context=None, error=RuntimeError("x")
            )
            is None
        )

    assert "E2B tool" not in caplog.text


async def test_before_tool_callback_keeps_sandbox_alive(
    mock_sandbox: MagicMock,
) -> None:
    # Every owned tool call must push the sandbox expiry window forward using
    # the configured timeout.
    plugin = E2BPlugin(timeout=1234)
    mock_sandbox.set_timeout = AsyncMock()
    plugin._manager._sandbox = mock_sandbox  # sandbox already created

    tool = plugin.get_tools()[0]
    out = await plugin.before_tool_callback(tool=tool, tool_args={}, tool_context=None)

    # Must return None: a non-None return would make ADK treat it as the tool
    # result and skip running the tool entirely.
    assert out is None
    mock_sandbox.set_timeout.assert_awaited_once_with(1234)


async def test_before_tool_callback_no_sandbox_no_keepalive(
    mock_sandbox: MagicMock,
) -> None:
    # Before the first tool call there is no sandbox: the keep-alive must be a
    # no-op (and must not create one).
    plugin = E2BPlugin()
    mock_sandbox.set_timeout = AsyncMock()

    tool = plugin.get_tools()[0]
    await plugin.before_tool_callback(tool=tool, tool_args={}, tool_context=None)

    mock_sandbox.set_timeout.assert_not_called()
    assert plugin._manager._sandbox is None
