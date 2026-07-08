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
        result = await runner.run_debug("Compute the 20th Fibonacci number.")
        print(result)


asyncio.run(main())
```

`get_tools()` returns tool instances that all share the plugin's single sandbox,
so state written by one tool call is visible to the next. When the runner's
`async with` block exits, the plugin's `close()` fires and the sandbox is killed.

> The examples use `gemini-2.5-flash`, which runs on a free Gemini key. Swap to
> `gemini-2.5-pro` for stronger reasoning (it needs a paid tier — a free key
> returns HTTP 429).

## Tools

`plugin.get_tools()` returns six tools. Each returns a JSON-serializable dict
with a `success` flag — tools report failures in the result rather than raising,
so a bad call never aborts the agent run.

| Tool | Does | Key result fields |
|------|------|-------------------|
| `run_code` | Run code in a stateful kernel (variables persist across calls) | `stdout`, `stderr`, `text`, `error` |
| `run_command` | Run a shell command (each call is independent) | `stdout`, `stderr`, `exit_code` |
| `write_file` | Write a file in the sandbox | `path` |
| `read_file` | Read a file back | `path`, `content` |
| `list_files` | List a directory | `entries` (`[{name, type}]`) |
| `start_background_command` | Start a long-running process; optional preview URL for a port | `pid`, `preview_url`, `readiness` |

### Configuration

`E2BPlugin` takes keyword-only options, all optional:

```python
E2BPlugin(
    api_key=None,       # defaults to E2B_API_KEY
    template=None,      # E2B sandbox template
    metadata=None,      # dict[str, str] attached to the sandbox
    envs=None,          # dict[str, str] environment variables
    timeout=None,       # sandbox timeout in seconds
    plugin_name="e2b_plugin",
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
  to run one at a time, not concurrently.
- **Text-only output.** Tools return text — `stdout`/`stderr`/file contents.
  Rich results (charts, dataframes, images) are not surfaced yet.
- **Lazy, shared sandbox lifecycle.** The sandbox is created on the first tool
  call and reused for the agent's lifetime, then killed when the runner exits.
- **Bounded output.** Large output is truncated with a `…[truncated N bytes]`
  marker so a single call can't flood the model's context.

## License

MIT — see [LICENSE](LICENSE).
