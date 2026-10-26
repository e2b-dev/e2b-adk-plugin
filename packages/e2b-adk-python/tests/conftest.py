"""Shared pytest fixtures. Sandbox creation is always mocked — no live E2B."""

from __future__ import annotations

from collections.abc import Iterator
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture
def mock_sandbox() -> MagicMock:
    """A stand-in for ``AsyncSandbox`` with an async ``kill()`` and a ``sandbox_id``."""
    sandbox = MagicMock(name="AsyncSandbox")
    sandbox.sandbox_id = "sbx_test_123"
    sandbox.kill = AsyncMock(return_value=True)
    sandbox.set_timeout = AsyncMock()
    return sandbox


@pytest.fixture
def patched_create(mock_sandbox: MagicMock) -> Iterator[AsyncMock]:
    """Patch ``AsyncSandbox.create`` to return the mock sandbox (no network)."""
    with patch(
        "e2b_adk._sandbox.AsyncSandbox.create",
        new_callable=AsyncMock,
        return_value=mock_sandbox,
    ) as create_mock:
        yield create_mock
