---
catalog_title: E2B
catalog_description: Execute code, run shell commands, and manage files in secure E2B sandboxes
catalog_icon: /integrations/assets/e2b.png
catalog_tags: ["code"]
---

# E2B plugin for ADK

<div class="language-support-tag">
  <span class="lst-supported">Supported in ADK</span><span class="lst-python">Python v0.1.0</span>
</div>

The [e2b-adk](https://github.com/e2b-dev/e2b-adk-plugin) plugin connects your
ADK agent to [E2B](https://e2b.dev) sandboxes. This integration gives your
agent the ability to execute code in a real, stateful Python kernel, run shell
commands, manage files, and drive long-running background processes — all
inside an isolated sandbox, so the model's code executes for real instead of
being trusted blind.

## Use cases

- **Secure Code Execution**: Run Python, JavaScript, TypeScript, R, Java, or
  Bash in an isolated sandbox with a stateful kernel — variables and imports
  persist across calls, so the agent can build on its own previous results.

- **Shell Command Automation**: Run shell commands with configurable working
  directories, environment variables, and timeouts for installs, builds, or
  inspecting the sandbox filesystem.

- **File Management**: Write scripts and datasets into the sandbox, then read
  back generated outputs, or list a directory to explore what's there.

- **Background Processes**: Start a long-running process such as a dev server
  and get its PID back immediately, with an optional preview URL for an
  exposed port.

## Prerequisites

- An [E2B](https://e2b.dev) account
- E2B API key

## Installation

```bash
pip install e2b-adk
```

## Use with agent

```python
from e2b_adk import E2BPlugin
from google.adk.agents import Agent

plugin = E2BPlugin(
    # Reads E2B_API_KEY from the environment by default;
    # pass api_key="your-e2b-api-key" to override
)

root_agent = Agent(
    model="gemini-2.5-flash",
    name="sandbox_agent",
    instruction="Help users execute code and commands in a secure sandbox",
    tools=plugin.get_tools(),
)
```

## Configuration

`E2BPlugin` takes keyword-only options, all optional — anything you don't set
falls back to E2B's own default.

- **`template`**: E2B sandbox template to use (custom base image / packages).
- **`envs`**: environment variables set inside the sandbox.
- **`timeout`**: sandbox timeout in seconds; re-applied on every tool call so
  an active session doesn't expire mid-run.
- **`lifecycle`**: what happens when the sandbox times out, e.g.
  `{"on_timeout": {"action": "pause"}, "auto_resume": True}` to pause and
  auto-resume instead of killing it.

Every other `AsyncSandbox.create()` option (`secure`, `mcp`, `network`,
`volume_mounts`, connection params, ...) is forwarded the same way — see the
[full option list](https://github.com/e2b-dev/e2b-adk-plugin#configuration) in
the repository README.

## Available tools

Each tool returns a dict with a `success` flag instead of raising, so a bad
call never aborts the agent run. `success` means the tool *ran*: code that
raised or a command that exited non-zero still returns `success: True` with
the failure captured in the result; only a call that couldn't run at all
(sandbox unavailable, timeout) returns `success: False`.

Tool | Description
---- | -----------
`run_code` | Execute code in a stateful kernel (Python, JavaScript, TypeScript, R, Java, Bash)
`run_command` | Run a shell command in the sandbox
`write_file` | Write a file into the sandbox
`read_file` | Read a file from the sandbox
`list_files` | List a directory in the sandbox
`start_background_command` | Start a long-running process and return its PID, with an optional preview URL for a port

## Notes

- All tools share one sandbox per plugin instance, kept alive for as long as
  the agent is active; an idle gap longer than the configured timeout expires
  it under E2B's default lifecycle (opt into pause/auto-resume via the
  `lifecycle` option to survive idle gaps instead).
- Tool calls are meant to run one at a time — concurrent calls are safe for
  the sandbox lifecycle, but share one filesystem and kernel.

## Resources

- `e2b-adk` on GitHub — TBA
- `e2b-adk` on PyPI — TBA
- Data analysis agent example — TBA
- Code generator agent example — TBA
- [E2B Documentation](https://e2b.dev/docs)
