# E2B for Google ADK

Give [Google ADK](https://github.com/google/adk-js) agents code, shell, file and background-process tools in an isolated [E2B](https://e2b.dev) sandbox. `E2BToolset` creates a shared workspace lazily and releases it when the ADK runner invocation finishes.

## Install

Requires Node.js 22 or later and an ESM project (`"type": "module"` in `package.json`). Tested with Google ADK 2.1.0.

```bash
npm install @google/adk @e2b/adk
npm install --save-dev tsx typescript @types/node
```

Set credentials in your application's environment:

```bash
export E2B_API_KEY="..."
export GOOGLE_API_KEY="..."
```

The integration is model-independent. The examples use Gemini 2.5 Flash through ADK's built-in provider. Credentials are used by the local SDKs and are not forwarded into the sandbox unless explicitly supplied in `envs`.

## Agent tools

```typescript
import { E2BToolset } from '@e2b/adk'
import { InMemoryRunner, LlmAgent } from '@google/adk'

const toolset = new E2BToolset()
const runner = new InMemoryRunner({
  agent: new LlmAgent({
    name: 'calculator',
    model: 'gemini-2.5-flash',
    instruction: 'Use run_code to verify calculations. Check its error field.',
    tools: [toolset],
  }),
})

try {
  for await (const event of runner.runEphemeral({
    userId: 'user',
    newMessage: { role: 'user', parts: [{ text: 'Compute 1234567 * 89.' }] },
    runConfig: { maxLlmCalls: 6 },
  })) {
    if (event.errorCode) throw new Error(`Agent failed: ${event.errorCode}`)
    for (const part of event.content?.parts ?? []) {
      if (part.text && !part.thought) console.log(part.text)
    }
  }
} finally {
  await toolset.close()
}
```

Pass the toolset itself in `tools: [toolset]` so ADK can close it. If you call `getTools()` and register individual tools instead, your application must call `close()` explicitly.

| Tool                       | Arguments                                              | Result fields besides `success`            |
| -------------------------- | ------------------------------------------------------ | ------------------------------------------ |
| `run_code`                 | `code`, optional `language`, `envs`, `timeoutMs`       | `stdout`, `stderr`, `text`, `error`        |
| `run_command`              | `command`, optional `cwd`, `envs`, `timeoutMs`         | `stdout`, `stderr`, `exit_code`            |
| `write_file`               | `path`, `content`                                      | `path`                                     |
| `read_file`                | `path`                                                 | `path`, `content`                          |
| `list_files`               | optional `path` (default `.`)                          | `entries`, `truncated`                     |
| `start_background_command` | `command`, optional `cwd`, `envs`, `timeoutMs`, `port` | `pid`, `preview_url`, optional `readiness` |

`run_code` supports `python` (default), `javascript`, `typescript`, `r`, `java` and `bash`. Kernel state persists between calls in the same sandbox. Commands start independent processes; their working directory and environment changes do not carry into the next command.

`success` means the operation ran. Code that raises still returns `success: true` with an `error`; a command exiting nonzero returns `success: true` with its `exit_code`. Invalid arguments and SDK/transport failures return `success: false` with an `error` rather than aborting the agent loop. SDK error messages are sanitized. Each text output is limited to 10,000 characters; directory listings contain at most 100 entries and indicate truncation.

## Configuration and lifecycle

```typescript
const toolset = new E2BToolset({
  template: 'your-code-interpreter-template',
  sandboxOptions: {
    timeoutMs: 300_000,
    metadata: { application: 'analyst' },
    allowInternetAccess: false,
  },
})
```

`template` selects the E2B template; omit it to use the Code Interpreter default. Custom templates must support the interpreters you intend to use. `sandboxOptions` accepts the E2B SDK's creation options except `template`. Unspecified network, lifecycle, environment and connection options retain the SDK defaults. Sandbox and tool timeout values use milliseconds. An operation's `timeoutMs: 0` disables its SDK execution deadline; the sandbox TTL still applies.

Creation, operations and teardown are serialized per instance. Active SDK operations refresh the sandbox TTL, including a heartbeat for operations longer than the TTL. The adapter does not silently replace an expired sandbox with an empty one. An explicit `close()` followed by another use creates a new workspace; a failed `close()` retains the handle so cleanup can be retried.

ADK 2.1.0 closes registered toolsets at the end of each runner invocation, including errors and cancellation. Files, kernel state and background processes are shared only within that invocation. A preview URL is syntactic, has `readiness: "unknown"`, and stops working when the sandbox closes. Use a separate toolset for each concurrent run or user; do not share a global instance between concurrent runner invocations. Finish consuming or explicitly close a runner's async iterator so its `finally` cleanup runs.

The adapter does not log tool arguments or SDK error bodies. Configure ADK and SDK tracing separately if your application handles sensitive inputs.

## Direct code executor

`E2BCodeExecutor` implements ADK's `BaseCodeExecutor`. Call `executeCode({ invocationContext, codeExecutionInput })` and close it explicitly in `finally`. See the complete [direct executor example](examples/code-executor.ts).

**ADK 2.1.0 limitation:** setting `LlmAgent({ codeExecutor })` alone does not execute model responses: ADK does not register its code execution response processor. Use `E2BToolset` for an autonomous agent. This package does not install a custom processor or import ADK internals.

Direct calls accept ADK's `CodeExecutionLanguage.PYTHON`, `JAVASCRIPT`, `TYPESCRIPT` and `SHELL` (mapped to bash). Unsupported languages, nonempty `inputFiles` and nonempty `args` return a descriptive `stderr` without creating a sandbox. Output contains bounded `stdout`/`stderr` and `outputFiles: []`; automatic file staging and artifact collection are not supported. The executor retains kernel state until `close()` and remains bound to its first ADK session to prevent accidental cross-session sharing.

## Examples and development

- [Data analysis agent](examples/data-analysis.ts): save a CSV, calculate results with Python, and report the answer.
- [Direct code executor](examples/code-executor.ts): reuse a stateful Python kernel through the ADK executor contract.

```bash
pnpm install --frozen-lockfile
pnpm check
```

Tests use real ADK runtime objects with mocked models and E2B SDK calls. Network access is blocked by the test fixtures; no API credentials are needed for CI. CI runs on Node 22 and 24.

For examples and paid live checks, copy `.env.example` to `.env` and supply your credentials locally:

```bash
pnpm example:analysis
pnpm example:executor
pnpm test:live
```

Live checks create real E2B sandboxes and make Gemini requests. They verify tool execution, supported languages and teardown, and clean up only workspaces tagged with their unique test-run ID. They are never part of `pnpm check` or CI.
