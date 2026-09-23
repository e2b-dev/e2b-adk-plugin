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

async function calculate(userId: string, question: string): Promise<string> {
  const toolset = new E2BToolset()
  const runner = new InMemoryRunner({
    agent: new LlmAgent({
      name: 'calculator',
      model: 'gemini-2.5-flash',
      instruction:
        'Use run_code to verify calculations. Check its error field.',
      tools: [toolset],
    }),
  })

  let answer = ''
  try {
    for await (const event of runner.runEphemeral({
      userId,
      newMessage: { role: 'user', parts: [{ text: question }] },
      runConfig: { maxLlmCalls: 6 },
    })) {
      if (event.errorCode) throw new Error(`Agent failed: ${event.errorCode}`)
      for (const part of event.content?.parts ?? []) {
        if (part.text && !part.thought) answer += part.text
      }
    }
  } finally {
    await toolset.close()
  }
  return answer
}

console.log(await calculate('user', 'Compute 1234567 * 89.'))
```

Create the toolset, agent and runner inside the request function, as above. Concurrent calls to `calculate()` then own separate sandboxes. Pass the toolset itself in `tools: [toolset]` so ADK's `runAsync()` / `runEphemeral()` can close it. If you register individual tools from `getTools()`, your application must call `close()` explicitly.

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

Creation, operations and teardown are serialized per instance. Active SDK operations refresh the sandbox TTL, including a heartbeat for operations longer than the TTL. The adapter does not silently replace an expired sandbox with an empty one. After successful `close()`, a new invocation can create a new workspace; late calls from the closed invocation are rejected. If cleanup fails, the handle is retained for retry and sandbox operations are blocked until `close()` succeeds. Keep the explicit `finally` cleanup: ADK 2.1.0 suppresses automatic toolset cleanup errors, whereas an explicit `close()` reports a safe error to your application.

ADK 2.1.0 closes registered toolsets at the end of `runAsync()` / `runEphemeral()`, including errors and cancellation. `runLive()` does not automatically close toolsets; always call `close()` in `finally` for that mode. Files, kernel state and background processes are shared within a single invocation. A preview URL is syntactic, has `readiness: "unknown"`, and stops working when the sandbox closes. Finish consuming or explicitly close a runner's async iterator so its `finally` cleanup runs.

Overlapping invocations must use separate toolsets, even within the same user session. Detecting an overlap permanently invalidates the shared instance; subsequent discovery or tool calls fail, and `close()` still releases its sandbox. Because ADK calls `close()` without identifying the invocation, a competing runner's cleanup can interrupt the original run. This guard prevents cross-invocation access and silent workspace recreation; it does not make shared concurrent use supported. Create a new toolset after such a conflict.

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
