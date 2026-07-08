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
from typing import Any

from e2b.sandbox.main import SandboxBase
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
        re-created here (see :meth:`refresh_timeout` for the keep-alive that
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
        Refreshing on every tool call keeps a busy session's sandbox alive
        indefinitely; only an idle gap longer than the timeout still expires
        it. Best-effort: a keep-alive failure is logged and swallowed so it
        can never break the tool call that triggered it.
        """
        sandbox = self._sandbox
        if sandbox is None:
            return
        timeout: int = self._opts.get("timeout") or SandboxBase.default_sandbox_timeout
        try:
            await sandbox.set_timeout(timeout)
        except Exception as exc:  # noqa: BLE001 — keep-alive is best-effort
            logger.debug("sandbox keep-alive failed: %s", exc)

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
