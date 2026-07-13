# e2b-adk

A [Google ADK](https://google.github.io/adk-docs/) plugin backed by
[E2B](https://e2b.dev) sandboxes. Attach it to an ADK agent and the agent can
generate and run code, execute shell commands, read and write files, and start
long-running processes — all inside an isolated E2B sandbox, with no
infrastructure of your own.

Under the hood every tool call runs in the
[E2B Code Interpreter](https://e2b.dev/docs), so the model's code executes in a
real Python kernel instead of being trusted blind.

## Install

```bash
pip install e2b-adk
```

Or with [uv](https://docs.astral.sh/uv/):

```bash
uv pip install e2b-adk
```

## Credentials

You need an E2B API key for the sandbox and a model key for the agent's LLM
(Gemini is ADK's default):

```bash
export E2B_API_KEY="..."
export GOOGLE_API_KEY="..."
```

Get an E2B key at [e2b.dev/dashboard](https://e2b.dev/dashboard).

## Quickstart

Create the plugin, hand its tools to an `Agent`, and register the plugin on the
`App`. The plugin owns the sandbox lifecycle — you never create or tear one down
yourself.

```python
import asyncio

from google.adk.agents import Agent
from google.adk.apps import App
from google.adk.runners import InMemoryRunner

from e2b_adk import E2BPlugin


async def main() -> None:
    plugin = E2BPlugin()
    agent = Agent(
        model="gemini-2.5-flash",
        name="coder",
        instruction="Write and run Python to answer the user. Verify with run_code.",
        tools=plugin.get_tools(),
    )
    app = App(name="demo", root_agent=agent, plugins=[plugin])

    async with InMemoryRunner(app=app) as runner:
        # run_debug prints the conversation as it runs.
        await runner.run_debug("Compute the 20th Fibonacci number.")


asyncio.run(main())
```

## Tools

`plugin.get_tools()` returns six tools. Each returns a JSON-serializable dict
with a `success` flag — tools report failures in the result rather than raising,
so a bad call never aborts the agent run. `success` means the tool *ran*: code
that raised or a command that exited non-zero still returns `success: True` with
the failure captured in `error` / `exit_code`. Only a call that could not run at
all (sandbox unavailable, timeout) returns `success: False`.

| Tool | Does | Key result fields |
|------|------|-------------------|
| `run_code` | Run code in a stateful kernel (variables persist across calls) | `stdout`, `stderr`, `text`, `error` |
| `run_command` | Run a shell command (each call is independent) | `stdout`, `stderr`, `exit_code` |
| `write_file` | Write a file in the sandbox | `path` |
| `read_file` | Read a file back | `path`, `content` |
| `list_files` | List a directory | `entries` (`[{name, type}]`) |
| `start_background_command` | Start a long-running process; optional preview URL for a port | `pid`, `preview_url` (+ `readiness` when `port` is set) |

### Configuration

`E2BPlugin` takes keyword-only options, all optional. Anything you don't set
falls back to the E2B SDK's own default — the plugin overrides none of them.

```python
E2BPlugin(
    # Common options
    api_key=None,               # defaults to the E2B_API_KEY env var
    template=None,              # E2B sandbox template
    metadata=None,              # dict[str, str] attached to the sandbox
    envs=None,                  # dict[str, str] environment variables
    timeout=None,               # sandbox timeout in seconds (re-applied on every tool call)
    plugin_name="e2b_plugin",
    # Passed straight through to AsyncSandbox.create() — see the E2B SDK docs
    secure=None,
    allow_internet_access=None,
    mcp=None,
    network=None,
    lifecycle=None,             # e.g. pause/auto-resume; defaults to E2B's behavior
    volume_mounts=None,
    # **opts: any other AsyncSandbox.create() / connection param (proxy, request_timeout, …)
)
```

## Examples

- [`examples/data_analysis.py`](examples/data_analysis.py) — a data-analysis
  agent that saves a dataset and computes real answers with pandas instead of
  guessing.
- [`examples/code_generator.py`](examples/code_generator.py) — a code generator
  that executes every snippet before returning it.

Run one with the credentials above:

```bash
uv run --extra examples python examples/data_analysis.py
```

## v1 notes

- **Sequential tool calls.** One sandbox is shared per plugin; calls are meant
  to run one at a time, not concurrently. Concurrent calls are safe for the
  sandbox lifecycle (creation is locked) but share one filesystem and kernel.
- **Text-only output.** Tools return text — `stdout`/`stderr`/file contents.
  Rich results (charts, dataframes, images) are not surfaced yet.
- **Lazy, shared sandbox lifecycle.** The sandbox is created on the first tool
  call and reused for the agent's lifetime, then killed when the runner exits.
- **Keep-alive while active, expiry when idle.** Every tool call pushes the
  sandbox's expiry window forward by `timeout` (E2B's default is 300s), so an
  active session never expires mid-run. An idle gap longer than `timeout` still
  expires the sandbox under E2B's default lifecycle (`on_timeout: kill`), and
  later tool calls return failure results — pass e.g.
  `lifecycle={"on_timeout": {"action": "pause"}, "auto_resume": True}` to pause
  and auto-resume across idle gaps instead.
- **Bounded output.** Output larger than 10 KB per field is truncated with a
  `…[truncated N bytes]` marker so a single call can't flood the model's context.

## License

MIT — see [LICENSE](LICENSE).
