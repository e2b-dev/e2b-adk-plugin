"""Live smoke tests against a real E2B sandbox (and Gemini for the agent test).

These are excluded from the default ``pytest`` run — they create a billable
sandbox and call external APIs. Run them explicitly::

    uv run pytest -m live -v

Requires ``E2B_API_KEY`` (and ``GOOGLE_API_KEY`` for the agent test) in the
environment or in a root ``.env`` file.
"""

from __future__ import annotations

import asyncio
import os
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from e2b_adk import E2BPlugin


def _load_root_dotenv() -> None:
    """Populate ``os.environ`` from the repo-root ``.env`` (existing vars win)."""
    env_path = Path(__file__).resolve().parents[1] / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip("'\""))


_load_root_dotenv()

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(
        not os.environ.get("E2B_API_KEY"), reason="E2B_API_KEY not set"
    ),
]


def _by_name(plugin: E2BPlugin) -> dict[str, object]:
    return {tool.name: tool for tool in plugin.get_tools()}


async def _fetch_status(url: str, *, attempts: int = 10, delay: float = 3.0) -> int:
    """Poll ``url`` until it responds, returning the final HTTP status."""
    last_error: Exception | None = None
    for _ in range(attempts):
        try:
            response = await asyncio.to_thread(
                urllib.request.urlopen, url, None, 10
            )
            return int(response.status)
        except urllib.error.HTTPError as exc:  # reachable — a status is a status
            return int(exc.code)
        except Exception as exc:  # noqa: BLE001 — not up yet, retry
            last_error = exc
            await asyncio.sleep(delay)
    raise AssertionError(f"preview URL never became reachable: {last_error}")


async def test_all_tools_against_live_sandbox() -> None:
    """One sandbox, all six tools, real E2B — the mock-fidelity check."""
    plugin = E2BPlugin(metadata={"purpose": "smoke-test"})
    tools = _by_name(plugin)
    try:
        # run_code: stdout, main-result text, empty error
        result = await tools["run_code"].run_async(
            args={"code": "x = 6 * 7\nprint('stdout works')\nx"}, tool_context=None
        )
        assert result["success"] is True, result
        assert "stdout works" in result["stdout"]
        assert result["text"] == "42"
        assert result["error"] == ""

        # run_code: kernel state persists across calls (stateful sessions)
        result = await tools["run_code"].run_async(
            args={"code": "x + 1"}, tool_context=None
        )
        assert result["success"] is True, result
        assert result["text"] == "43"

        # run_code: ran-but-errored → success stays true, traceback normalized
        result = await tools["run_code"].run_async(
            args={"code": "1 / 0"}, tool_context=None
        )
        assert result["success"] is True, result
        assert "ZeroDivisionError" in result["error"]

        # run_command: success path
        result = await tools["run_command"].run_async(
            args={"command": "echo live-echo"}, tool_context=None
        )
        assert result["success"] is True, result
        assert "live-echo" in result["stdout"]
        assert result["exit_code"] == 0

        # run_command: non-zero exit is a result, not an exception
        result = await tools["run_command"].run_async(
            args={"command": "ls /definitely-not-here"}, tool_context=None
        )
        assert result["success"] is True, result
        assert result["exit_code"] != 0
        assert result["stderr"]

        # write_file → read_file roundtrip
        result = await tools["write_file"].run_async(
            args={"path": "/tmp/smoke.txt", "content": "smoke payload"},
            tool_context=None,
        )
        assert result["success"] is True, result
        result = await tools["read_file"].run_async(
            args={"path": "/tmp/smoke.txt"}, tool_context=None
        )
        assert result["success"] is True, result
        assert result["content"] == "smoke payload"

        # read_file: missing path → failure result, no exception
        result = await tools["read_file"].run_async(
            args={"path": "/tmp/definitely-missing.txt"}, tool_context=None
        )
        assert result["success"] is False, result
        assert result["path"] == "/tmp/definitely-missing.txt"

        # list_files: the written file shows up with a string type
        result = await tools["list_files"].run_async(
            args={"path": "/tmp"}, tool_context=None
        )
        assert result["success"] is True, result
        entries = {entry["name"]: entry["type"] for entry in result["entries"]}
        assert entries.get("smoke.txt") == "file"

        # start_background_command: pid + reachable preview URL
        result = await tools["start_background_command"].run_async(
            args={"command": "python3 -m http.server 8000", "port": 8000},
            tool_context=None,
        )
        assert result["success"] is True, result
        assert isinstance(result["pid"], int)
        assert result["readiness"] == "unknown"
        preview_url = result["preview_url"]
        assert preview_url and preview_url.startswith("https://")
        assert "8000" in preview_url
        status = await _fetch_status(preview_url)
        assert status == 200, f"preview URL responded with {status}"
    finally:
        await plugin.close()


@pytest.mark.skipif(
    not os.environ.get("GOOGLE_API_KEY"), reason="GOOGLE_API_KEY not set"
)
async def test_agent_end_to_end_uses_sandbox() -> None:
    """Full ADK loop: Gemini drives run_code inside a real sandbox."""
    from google.adk.agents import Agent
    from google.adk.apps import App
    from google.adk.runners import InMemoryRunner

    plugin = E2BPlugin(metadata={"purpose": "smoke-test-agent"})
    agent = Agent(
        model="gemini-2.5-flash",
        name="smoke_agent",
        instruction=(
            "You MUST use the run_code tool to compute answers — never answer "
            "from memory. Reply with just the number."
        ),
        tools=plugin.get_tools(),
    )
    app = App(name="smoke_app", root_agent=agent, plugins=[plugin])

    async with InMemoryRunner(app=app) as runner:
        events = await runner.run_debug(
            "Compute the 10th Fibonacci number (F(1)=F(2)=1).", quiet=True
        )

    # The model must have actually called our tool (not answered from memory)...
    called_tools = {
        call.name for event in events for call in event.get_function_calls()
    }
    assert "run_code" in called_tools, f"tools called: {called_tools or 'none'}"

    # ...and the final answer must contain the correct value computed in E2B.
    final_texts = [
        part.text
        for event in events
        if event.author != "user" and event.content and event.content.parts
        for part in event.content.parts
        if part.text
    ]
    assert any("55" in text for text in final_texts), final_texts
