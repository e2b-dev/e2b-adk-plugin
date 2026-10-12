"""Flagship example: a self-verifying code generator.

The agent is instructed to *run* every snippet in the E2B sandbox (via the
``run_code`` tool provided by :class:`e2b_adk.E2BPlugin`) before returning any
code — so what it hands back has actually been executed and its tests passed.

Nothing here touches the network at import time: the sandbox is created lazily
on the first tool call, and all live work happens inside ``main()`` under
``asyncio.run``. A live run needs ``E2B_API_KEY`` plus a model key (e.g.
``GOOGLE_API_KEY``) exported in the environment.

Run with::

    uv run --extra examples python examples/code_generator.py
"""

from __future__ import annotations

import asyncio

try:
    # Optional convenience: load a local .env if python-dotenv is installed
    # (it ships in the `examples` extra). Absence must not break import.
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

from google.adk.agents import Agent
from google.adk.apps import App
from google.adk.runners import InMemoryRunner

from e2b_adk import E2BPlugin

INSTRUCTION = """You are a code generator that returns verified, working code.
For every request: (1) write the function, (2) write tests, (3) EXECUTE in the
sandbox with run_code, (4) if it fails, fix and re-run until tests pass, (5) return
ONLY the final function. Never return code you haven't executed."""


async def main() -> None:
    # The sandbox uses E2B's default lifecycle (killed on timeout). To keep the
    # kernel and files alive across idle gaps instead, pass e.g.
    # ``lifecycle={"on_timeout": {"action": "pause"}, "auto_resume": True}``.
    plugin = E2BPlugin(metadata={"example": "code-generator"})
    agent = Agent(
        model="gemini-2.5-flash",
        name="codegen",
        instruction=INSTRUCTION,
        tools=plugin.get_tools(),
    )
    app = App(name="codegen_app", root_agent=agent, plugins=[plugin])
    async with InMemoryRunner(app=app) as runner:
        # run_debug prints the conversation as it runs.
        await runner.run_debug(
            "Write a Python function group_by(items, key) that groups a list "
            "by a key function."
        )


if __name__ == "__main__":
    asyncio.run(main())
