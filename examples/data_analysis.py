"""Second example: a data-analysis agent.

The agent is handed a small raw dataset and asked a question about it. Instead
of guessing, it writes the data to a file in the E2B sandbox (``write_file``),
runs real pandas/numpy code against it (``run_code`` — a stateful Python kernel
with the data-science stack preinstalled), inspects the output, and iterates if
the code errors — then reports its findings in plain text.

This is deliberately different from ``code_generator.py``: nothing is returned
as a reusable function. The value is the *analysis* — the agent uses the sandbox
as a calculator it can't fool, so the numbers it reports are computed, not
hallucinated.

Nothing here touches the network at import time: the sandbox is created lazily
on the first tool call, and all live work happens inside ``main()`` under
``asyncio.run``. A live run needs ``E2B_API_KEY`` plus a model key (e.g.
``GOOGLE_API_KEY``) exported in the environment.

Run with::

    uv run --extra examples python examples/data_analysis.py
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

INSTRUCTION = """You are a data analyst. You never guess numbers — you compute
them. For every question:
(1) save any data you are given to a file in the sandbox with write_file,
(2) analyse it by writing and running real Python (pandas/numpy) with run_code,
(3) if the code errors, read the message, fix it, and re-run until it works,
(4) report your findings in clear prose, citing the figures you computed.
Do not report a number you have not verified by running code."""

# A compact monthly marketing dataset. Kept inline so the example is fully
# self-contained — no download, no external data dependency.
DATASET = """\
month,region,marketing_spend,revenue
2024-01,North,12000,48000
2024-02,North,15000,61000
2024-03,North,9000,37000
2024-04,North,18000,72000
2024-05,North,21000,80000
2024-06,North,16000,64000
2024-01,South,8000,26000
2024-02,South,11000,30000
2024-03,South,14000,33000
2024-04,South,17000,38000
2024-05,South,20000,44000
2024-06,South,23000,49000
"""

QUESTION = f"""Here is six months of marketing spend and revenue for two regions
as CSV:

{DATASET}
Save it to sales.csv, then answer: which region converts marketing spend into
revenue more efficiently, how strong is the spend-to-revenue relationship in
each region, and which single month was the best performer overall?"""


async def main() -> None:
    plugin = E2BPlugin(metadata={"example": "data-analysis"})
    agent = Agent(
        model="gemini-2.5-flash",
        name="data_analyst",
        instruction=INSTRUCTION,
        tools=plugin.get_tools(),
    )
    app = App(name="data_analysis_app", root_agent=agent, plugins=[plugin])
    async with InMemoryRunner(app=app) as runner:
        resp = await runner.run_debug(QUESTION)
        print(resp)


if __name__ == "__main__":
    asyncio.run(main())
