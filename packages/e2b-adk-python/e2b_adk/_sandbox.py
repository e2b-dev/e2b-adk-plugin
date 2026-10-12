"""Lazy E2B sandbox lifecycle management.

``SandboxManager`` owns a single ``AsyncSandbox`` that is created lazily on the
first tool call and reused for the lifetime of the plugin instance, then torn
down on shutdown. An ``asyncio.Lock`` guards creation and teardown so that
concurrent tool calls (an agent turn may dispatch several at once) can never
create two sandboxes and leak one.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any, cast

from e2b_code_interpreter import AsyncSandbox

logger = logging.getLogger(__name__)


class SandboxManager:
    """Lazily creates and caches one ``AsyncSandbox``.

    Any keyword arguments (``api_key``, ``template``, ``metadata``, ``envs``,
    ``timeout``, ...) are stored and forwarded verbatim to
    ``AsyncSandbox.create(...)`` on first use.
    """

    def __init__(self, **opts: Any) -> None:
        self._opts: dict[str, Any] = opts
        self._sandbox: AsyncSandbox | None = None
        self._lock = asyncio.Lock()

    async def get(self) -> AsyncSandbox:
        """Return the live sandbox, creating it on the first call and caching it.

        Subsequent calls return the cached instance without creating a second
        sandbox. Creation is guarded by a lock with a double-check so that two
        concurrent first calls create exactly one sandbox, never two.

        The cached handle is returned as-is without a liveness check: an
        already-created sandbox that has since expired is not detected or
        re-created here (see :meth:`keep_alive` for the keep-alive scope that
        prevents expiry during active use).
        """
        if self._sandbox is None:
            async with self._lock:
                if self._sandbox is None:
                    self._sandbox = await AsyncSandbox.create(**self._opts)
        return self._sandbox

    async def refresh_timeout(self) -> None:
        """Push the sandbox's expiry window forward (no-op when none exists).

        An E2B sandbox expires ``timeout`` seconds (SDK default 300) after
        creation or the last ``set_timeout`` call — *not* after the last use.
        This one-shot operation is also used by :meth:`keep_alive`, whose
        recurring heartbeat covers an SDK operation that runs longer than the
        timeout. Best-effort: a keep-alive failure is logged and swallowed.
        """
        sandbox = self._sandbox
        if sandbox is not None:
            await self._refresh_sandbox(sandbox)

    def _timeout_seconds(self) -> int:
        """Return the caller-configured TTL or E2B's default."""
        timeout = self._opts.get("timeout")
        if isinstance(timeout, int) and timeout > 0:
            return timeout
        return int(AsyncSandbox.default_sandbox_timeout)

    def _keepalive_interval_seconds(self) -> float:
        """Refresh halfway through the TTL, with a small positive floor."""
        return max(self._timeout_seconds() / 2, 0.1)

    async def _refresh_sandbox(self, sandbox: AsyncSandbox) -> None:
        """Best-effort refresh for the currently cached sandbox."""
        if self._sandbox is not sandbox:
            return
        try:
            # E2B's class_method_variant decorator exposes set_timeout to mypy
            # as Any | None even though the bound instance method is awaitable.
            await cast(Any, sandbox).set_timeout(self._timeout_seconds())
        except Exception as exc:  # noqa: BLE001 — keep-alive is best-effort
            logger.debug("sandbox keep-alive failed: %s", exc)

    async def _keepalive_loop(self, sandbox: AsyncSandbox) -> None:
        """Refresh ``sandbox`` until its active SDK operation finishes."""
        while self._sandbox is sandbox:
            await asyncio.sleep(self._keepalive_interval_seconds())
            await self._refresh_sandbox(sandbox)

    @asynccontextmanager
    async def keep_alive(self, sandbox: AsyncSandbox) -> AsyncIterator[None]:
        """Keep ``sandbox`` alive for the full duration of one SDK operation.

        The first refresh handles cached sandboxes, the heartbeat prevents a
        call longer than the TTL from expiring mid-run, and the final refresh
        starts a full idle window when the operation completes. Every refresh
        is best-effort so lifecycle maintenance never changes a tool result.
        """
        await self._refresh_sandbox(sandbox)
        heartbeat = asyncio.create_task(self._keepalive_loop(sandbox))
        try:
            yield
        finally:
            heartbeat.cancel()
            await asyncio.gather(heartbeat, return_exceptions=True)
            await self._refresh_sandbox(sandbox)

    async def shutdown(self) -> None:
        """Kill the sandbox if one exists and clear the cache.

        A no-op when no sandbox was ever created. The cache is cleared even if
        ``kill()`` raises (the error still propagates), so a dead sandbox is
        never handed back — after shutdown, a later ``get()`` lazily creates a
        fresh sandbox. Holds the same lock as ``get()`` so teardown cannot race
        with a concurrent create.
        """
        async with self._lock:
            if self._sandbox is not None:
                try:
                    await self._sandbox.kill()
                finally:
                    self._sandbox = None
