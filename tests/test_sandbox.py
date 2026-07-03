"""Lifecycle tests for ``SandboxManager`` using a mocked ``AsyncSandbox``."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from e2b_adk._sandbox import SandboxManager


async def test_lazy_create_and_cache(
    patched_create: AsyncMock, mock_sandbox: MagicMock
) -> None:
    manager = SandboxManager(api_key="test-key")

    # No sandbox created until the first get().
    patched_create.assert_not_called()

    first = await manager.get()
    assert first is mock_sandbox
    patched_create.assert_awaited_once()
    # api_key + other opts flow through to create().
    assert patched_create.await_args.kwargs["api_key"] == "test-key"

    # Second get() returns the cached instance without a second create.
    second = await manager.get()
    assert second is first
    patched_create.assert_awaited_once()


async def test_shutdown_kills_and_resets(
    patched_create: AsyncMock, mock_sandbox: MagicMock
) -> None:
    manager = SandboxManager()

    await manager.get()
    await manager.shutdown()

    mock_sandbox.kill.assert_awaited_once()

    # A later get() creates a fresh sandbox.
    await manager.get()
    assert patched_create.await_count == 2


async def test_shutdown_resets_cache_even_if_kill_fails(
    patched_create: AsyncMock, mock_sandbox: MagicMock
) -> None:
    mock_sandbox.kill = AsyncMock(side_effect=RuntimeError("kill failed"))
    manager = SandboxManager()

    await manager.get()

    # kill() error propagates, but the cache must still be cleared.
    with pytest.raises(RuntimeError, match="kill failed"):
        await manager.shutdown()

    # A later get() creates a fresh sandbox rather than reusing the dead one.
    await manager.get()
    assert patched_create.await_count == 2


async def test_shutdown_noop_when_never_created(
    patched_create: AsyncMock, mock_sandbox: MagicMock
) -> None:
    manager = SandboxManager()

    # Never created — shutdown must not kill anything and must not raise.
    await manager.shutdown()

    patched_create.assert_not_called()
    mock_sandbox.kill.assert_not_called()
