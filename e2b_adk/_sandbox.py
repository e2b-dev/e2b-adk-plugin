"""Lazy E2B sandbox lifecycle management.

``SandboxManager`` owns a single ``AsyncSandbox`` that is created lazily on the
first tool call and reused for the lifetime of the plugin instance, then torn
down on shutdown. An ``asyncio.Lock`` guards creation and teardown so that
concurrent tool calls (an agent turn may dispatch several at once) can never
create two sandboxes and leak one.
"""

from __future__ import annotations

import asyncio
from typing import Any

from e2b_code_interpreter import AsyncSandbox


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
        """
        if self._sandbox is None:
            async with self._lock:
                if self._sandbox is None:
                    self._sandbox = await AsyncSandbox.create(**self._opts)
        return self._sandbox

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
