"""Lifecycle tests for ``SandboxManager`` using a mocked ``AsyncSandbox``."""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from e2b_adk._sandbox import SandboxManager


def _fresh_sandbox(tag: str) -> MagicMock:
    """A distinct fake ``AsyncSandbox`` so tests can tell instances apart."""
    sbx = MagicMock(name=f"AsyncSandbox[{tag}]")
    sbx.sandbox_id = f"sbx_{tag}"
    sbx.kill = AsyncMock(return_value=True)
    return sbx


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


# --------------------------------------------------------------------------- #
# Keep-alive — refresh_timeout() pushes the expiry window forward on demand.
# --------------------------------------------------------------------------- #


async def test_refresh_timeout_noop_when_never_created(
    patched_create: AsyncMock, mock_sandbox: MagicMock
) -> None:
    manager = SandboxManager()

    # No sandbox yet — refresh must not create one and must not raise.
    await manager.refresh_timeout()

    patched_create.assert_not_called()


async def test_refresh_timeout_uses_configured_timeout() -> None:
    sandbox = _fresh_sandbox("keepalive")
    sandbox.set_timeout = AsyncMock()
    manager = SandboxManager(timeout=3600)
    manager._sandbox = sandbox

    await manager.refresh_timeout()

    sandbox.set_timeout.assert_awaited_once_with(3600)


async def test_refresh_timeout_defaults_to_sdk_timeout() -> None:
    from e2b.sandbox.main import SandboxBase

    sandbox = _fresh_sandbox("keepalive-default")
    sandbox.set_timeout = AsyncMock()
    manager = SandboxManager()  # no explicit timeout → SDK default applies
    manager._sandbox = sandbox

    await manager.refresh_timeout()

    sandbox.set_timeout.assert_awaited_once_with(SandboxBase.default_sandbox_timeout)


async def test_refresh_timeout_swallows_errors() -> None:
    # Keep-alive is best-effort: a set_timeout failure must never propagate
    # (it would otherwise break the tool call that triggered the refresh).
    sandbox = _fresh_sandbox("keepalive-broken")
    sandbox.set_timeout = AsyncMock(side_effect=RuntimeError("api down"))
    manager = SandboxManager()
    manager._sandbox = sandbox

    await manager.refresh_timeout()  # must not raise

    sandbox.set_timeout.assert_awaited_once()


async def test_refresh_timeout_after_shutdown_is_noop() -> None:
    # A refresh racing/following shutdown must neither raise nor resurrect the
    # sandbox: after shutdown the cache is None, so refresh returns early.
    sandbox = _fresh_sandbox("keepalive-shutdown")
    sandbox.set_timeout = AsyncMock()
    manager = SandboxManager()
    manager._sandbox = sandbox

    await manager.shutdown()
    await manager.refresh_timeout()

    sandbox.set_timeout.assert_not_called()
    assert manager._sandbox is None


# --------------------------------------------------------------------------- #
# Concurrency — the asyncio.Lock in get()/shutdown() must serialize creation
# so a burst of tool calls can never create (and leak) more than one sandbox.
# --------------------------------------------------------------------------- #


async def test_concurrent_get_creates_single_sandbox() -> None:
    """25 concurrent first-calls must create exactly ONE sandbox.

    The fake ``create`` suspends (``await asyncio.sleep(0)``) *after* acquiring
    the lock — precisely the window where, without the lock (or without the
    inner re-check), other callers would slip past the ``is None`` guard and
    each create their own sandbox. If this asserts >1, the lock has regressed.
    """
    create_count = 0
    created: list[MagicMock] = []

    async def slow_create(**opts: Any) -> MagicMock:
        nonlocal create_count
        create_count += 1
        await asyncio.sleep(0)  # yield so every queued get() gets a turn
        sbx = _fresh_sandbox(str(create_count))
        created.append(sbx)
        return sbx

    with patch("e2b_adk._sandbox.AsyncSandbox.create", new=slow_create):
        manager = SandboxManager()
        results = await asyncio.gather(*(manager.get() for _ in range(25)))

    assert create_count == 1, f"lock regressed: {create_count} sandboxes created"
    assert len(created) == 1
    assert all(r is created[0] for r in results)


async def test_second_get_waits_for_in_flight_create() -> None:
    """A second get() must block on the lock while the first is mid-create.

    ``create`` parks inside the lock until the test releases it; the second
    caller must not start its own create in the meantime.
    """
    release = asyncio.Event()
    create_count = 0

    async def blocking_create(**opts: Any) -> MagicMock:
        nonlocal create_count
        create_count += 1
        await release.wait()  # hold the lock until the test lets go
        return _fresh_sandbox(str(create_count))

    with patch("e2b_adk._sandbox.AsyncSandbox.create", new=blocking_create):
        manager = SandboxManager()
        first = asyncio.create_task(manager.get())
        second = asyncio.create_task(manager.get())
        await asyncio.sleep(0.01)  # let both tasks run up to their awaits

        assert create_count == 1, "second caller started a duplicate create"
        assert not first.done() and not second.done()

        release.set()
        r1, r2 = await asyncio.gather(first, second)

    assert create_count == 1
    assert r1 is r2


async def test_separate_managers_create_independent_sandboxes() -> None:
    """Each SandboxManager owns its own lock + sandbox — no cross-instance sharing."""
    created: list[MagicMock] = []

    async def make(**opts: Any) -> MagicMock:
        sbx = _fresh_sandbox(str(len(created)))
        created.append(sbx)
        return sbx

    with patch("e2b_adk._sandbox.AsyncSandbox.create", new=make):
        m1, m2 = SandboxManager(), SandboxManager()
        assert m1._lock is not m2._lock  # per-instance lock, not shared/class-level

        s1, s2 = await asyncio.gather(m1.get(), m2.get())

    assert len(created) == 2
    assert s1 is not s2


async def test_concurrent_get_after_shutdown_recreates_once() -> None:
    """After shutdown, a burst of concurrent get() creates exactly one fresh sandbox."""
    create_count = 0

    async def slow_create(**opts: Any) -> MagicMock:
        nonlocal create_count
        create_count += 1
        await asyncio.sleep(0)
        return _fresh_sandbox(str(create_count))

    with patch("e2b_adk._sandbox.AsyncSandbox.create", new=slow_create):
        manager = SandboxManager()
        first = await manager.get()
        await manager.shutdown()
        results = await asyncio.gather(*(manager.get() for _ in range(10)))

    assert create_count == 2  # one before shutdown, one for the whole burst after
    assert all(r is results[0] for r in results)
    assert results[0] is not first  # a genuinely new sandbox, not the killed one


async def test_shutdown_waits_for_in_flight_create() -> None:
    """shutdown() shares the lock, so it cannot run while a create is in flight.

    Guards against a teardown racing a concurrent create (which could kill the
    wrong instance or leave the freshly-created one orphaned).
    """
    release = asyncio.Event()
    sandbox = _fresh_sandbox("1")

    async def blocking_create(**opts: Any) -> MagicMock:
        await release.wait()
        return sandbox

    with patch("e2b_adk._sandbox.AsyncSandbox.create", new=blocking_create):
        manager = SandboxManager()
        getter = asyncio.create_task(manager.get())
        await asyncio.sleep(0.01)  # getter now holds the lock, parked in create

        shutter = asyncio.create_task(manager.shutdown())
        await asyncio.sleep(0.01)

        assert not shutter.done(), "shutdown ran while a create held the lock"
        sandbox.kill.assert_not_called()

        release.set()
        await asyncio.gather(getter, shutter)

    # Once create released the lock, shutdown proceeded and tore the sandbox down.
    sandbox.kill.assert_awaited_once()
    assert manager._sandbox is None
