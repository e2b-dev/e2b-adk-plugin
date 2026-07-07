"""Lazy E2B sandbox lifecycle management.

``SandboxManager`` owns a single ``AsyncSandbox`` that is created lazily on the
first tool call and reused for the lifetime of the plugin instance, then torn
down on shutdown. v1 assumes sequential tool calls, so there is no locking.
"""

from __future__ import annotations

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

    async def get(self) -> AsyncSandbox:
        """Return the live sandbox, creating it on the first call and caching it.

        Subsequent calls return the cached instance without creating a second
        sandbox.
        """
        if self._sandbox is None:
            self._sandbox = await AsyncSandbox.create(**self._opts)
        return self._sandbox

    async def shutdown(self) -> None:
        """Kill the sandbox if one exists and clear the cache.

        A no-op when no sandbox was ever created. The cache is cleared even if
        ``kill()`` raises (the error still propagates), so a dead sandbox is
        never handed back — after shutdown, a later ``get()`` lazily creates a
        fresh sandbox.
        """
        if self._sandbox is not None:
            try:
                await self._sandbox.kill()
            finally:
                self._sandbox = None
