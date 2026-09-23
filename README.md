# E2B for Google ADK

Give [Google ADK](https://github.com/google/adk-js) agents code, shell, file and background-process tools in an isolated [E2B](https://e2b.dev) sandbox. `E2BToolset` gives each ADK session its own lazily created workspace, which persists across the messages of that conversation until your application releases it or the sandbox times out.

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

// Create once per application, like any ADK root agent.
const toolset = new E2BToolset()
const runner = new InMemoryRunner({
  agent: new LlmAgent({
    name: 'calculator',
    model: 'gemini-2.5-flash',
    instruction: 'Use run_code to verify calculations. Check its error field.',
    tools: [toolset],
  }),
})

const session = await runner.sessionService.createSession({
  appName: runner.appName,
  userId: 'user',
})
try {
  for await (const event of runner.runAsync({
    userId: session.userId,
    sessionId: session.id,
    newMessage: { role: 'user', parts: [{ text: 'Compute 1234567 * 89.' }] },
  })) {
    if (event.errorCode) throw new Error(`Agent failed: ${event.errorCode}`)
    for (const part of event.content?.parts ?? [])
      if (part.text && !part.thought) process.stdout.write(part.text)
  }
} finally {
  // Release the sandbox when the conversation is over.
  await toolset.destroySession(session)
}
```

| Tool                       | Arguments                                              | Result fields besides `success`            |
| -------------------------- | ------------------------------------------------------ | ------------------------------------------ |
| `run_code`                 | `code`, optional `language`, `envs`, `timeoutMs`       | `stdout`, `stderr`, `text`, `error`        |
| `run_command`              | `command`, optional `cwd`, `envs`, `timeoutMs`         | `stdout`, `stderr`, `exit_code`            |
| `write_file`               | `path`, `content`                                      | `path`                                     |
| `read_file`                | `path`                                                 | `path`, `content`                          |
| `list_files`               | optional `path` (default `.`)                          | `entries`, `truncated`                     |
| `start_background_command` | `command`, optional `cwd`, `envs`, `timeoutMs`, `port` | `pid`, `preview_url`, optional `readiness` |

`run_code` supports `python` (default), `javascript`, `typescript`, `r`, `java` and `bash`, with one stateful kernel per language in each workspace. Commands start independent processes; their working directory and environment changes do not carry into the next command, but files do.

`success` means the operation ran. Code that raises still returns `success: true` with an `error`; a command exiting nonzero returns `success: true` with its `exit_code`. Invalid arguments and SDK/transport failures return `success: false` with an `error` rather than aborting the agent loop. SDK error messages are sanitized to their error class, such as `(FileNotFoundError)`. Each text output is limited to 10,000 characters; directory listings contain at most 100 entries and indicate truncation.

The call that creates a workspace also returns `workspace: "new"`. If the sandbox has expired or was deleted, the next call returns `success: false` with `workspace_expired: true`; the call after that starts a new, empty workspace. Agent instructions should tell the model to check these fields.

## Workspaces and cleanup

One `E2BToolset` can serve a module-level agent, the pattern `adk web` and `adk api_server` use. Workspaces are keyed by the ADK session (`appName`, `userId` and session `id`), never by model arguments, so concurrent sessions get separate sandboxes. Later messages and runs resumed after a tool confirmation reuse their session's files, kernels and background processes. Overlapping runs of one session share its workspace; their operations run one at a time.

ADK `close()` does not release session workspaces: ADK 2.1.0 calls it after every `runAsync()` without saying which run ended. The application owns cleanup through `destroySession(session)` and `destroyAll()`; the sandbox timeout remains the fallback. `destroySession()` kills the session's sandbox, fails its pending operations without recreating anything, and lets later messages in that session start a new workspace. If a kill fails, the call rejects, the workspace stays blocked, and a later `destroySession()` or `destroyAll()` retries. `destroyAll()` attempts every workspace before reporting failures; use it on shutdown.

`runEphemeral()` creates a session whose id your code never sees, so each call leaves a workspace that only `destroyAll()` or the sandbox timeout releases. Prefer `runAsync()` with sessions you create. Workspaces live in the toolset's memory: a deployment with several server processes gives each process its own workspace for the same session.

## Configuration and limits

```typescript
const toolset = new E2BToolset({
  template: 'your-code-interpreter-template',
  maxOperationMs: 600_000,
  sandboxOptions: {
    timeoutMs: 300_000,
    lifecycle: { onTimeout: 'pause', autoResume: true },
    metadata: { application: 'analyst' },
    allowInternetAccess: false,
  },
})
```

`template` selects the E2B template; omit it to use the Code Interpreter default. Custom templates must support the interpreters you intend to use and provide util-linux `setsid`. `sandboxOptions` accepts the E2B SDK's creation options except `template`; unspecified options keep the SDK defaults, so an idle sandbox is killed after five minutes. With `lifecycle: { onTimeout: 'pause' }` an idle sandbox is paused instead, and the next tool call in that session resumes it with its files and kernel state. Paused sandboxes are kept until destroyed, so release finished sessions.

`maxOperationMs` (default 10 minutes) bounds a single `run_code` or `run_command`. The model may pass `timeoutMs` from 1 up to that limit; omitted, it defaults to 60 seconds, as in the E2B SDK. The deadline starts when the operation starts running, not while it waits for an earlier one. When a deadline passes or the ADK run is aborted (`runAsync({ abortSignal })`), a command is killed with all its child processes and returns `timed_out` or `aborted`; code is stopped by restarting its kernel and returns `kernel_restarted: true`, because its variables are lost. If a kernel cannot be restarted, the workspace is blocked until `destroySession()`. Processes that start their own session with `setsid` escape this cleanup. Active operations keep extending the sandbox timeout.

`start_background_command` returns immediately and keeps the process running until it exits, its optional `timeoutMs` passes, or the workspace ends. A preview URL is syntactic and has `readiness: "unknown"`.

The E2B SDK buffers command and code output in memory before it is truncated. The adapter does not log tool arguments or SDK error bodies. Configure ADK and SDK tracing separately if your application handles sensitive inputs.

## Direct code executor

`E2BCodeExecutor` implements ADK's `BaseCodeExecutor`. Call `executeCode({ invocationContext, codeExecutionInput })` and call `close()` when you are done. See the complete [direct executor example](examples/code-executor.ts).

**ADK 2.1.0 limitation:** setting `LlmAgent({ codeExecutor })` alone does not execute model responses: ADK does not register its code execution response processor. Use `E2BToolset` for an autonomous agent. This package does not install a custom processor or import ADK internals.

Direct calls accept ADK's `CodeExecutionLanguage.PYTHON`, `JAVASCRIPT`, `TYPESCRIPT` and `SHELL` (mapped to bash). Unsupported languages, nonempty `inputFiles` and nonempty `args` return a descriptive `stderr` without creating a sandbox. Output contains bounded `stdout`/`stderr` and `outputFiles: []`; automatic file staging and artifact collection are not supported. Each call is limited to 60 seconds (or `maxOperationMs`, if lower); a timed-out call restarts the kernel. The executor keeps kernel state until `close()`, which releases the sandbox; a later call starts a new one. It stays bound to its first ADK session to prevent accidental cross-session sharing.

## Examples and development

- [Data analysis agent](examples/data-analysis.ts): a two-message conversation that saves a CSV once and reuses it.
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

Live checks create real E2B sandboxes and make Gemini requests (`LIVE_MODEL=openai pnpm test:live agent` uses a small OpenAI model through a test-only adapter instead). They verify the tools in every language, stopping commands and code, pause and resume, expiry, and a multi-user conversation with confirmation and cancellation. They clean up only workspaces tagged with their unique test-run ID and are never part of `pnpm check` or CI.
