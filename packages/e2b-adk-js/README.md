# E2B for Google ADK (TypeScript)

Give [Google ADK](https://github.com/google/adk-js) agents code, shell, file and background-process tools that run in an isolated [E2B](https://e2b.dev) sandbox. Each ADK session gets its own sandbox, which keeps files and kernel state across the messages of that conversation.

## Install

Requires Node.js 22 or later and an ESM project (`"type": "module"`). Tested with Google ADK 2.1.0.

```bash
npm install @google/adk @e2b/adk
npm install --save-dev tsx typescript @types/node
```

```bash
export E2B_API_KEY="..."
export GOOGLE_API_KEY="..."
```

## Quick start

```typescript
import { E2BToolset } from '@e2b/adk'
import { InMemoryRunner, LlmAgent } from '@google/adk'

// One toolset per application, like the root agent.
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

## Tools

| Tool                       | Arguments                                     | Returns                             |
| -------------------------- | --------------------------------------------- | ----------------------------------- |
| `run_code`                 | `code`, `language`, `envs`, `timeoutMs`       | `stdout`, `stderr`, `text`, `error` |
| `run_command`              | `command`, `cwd`, `envs`, `timeoutMs`         | `stdout`, `stderr`, `exit_code`     |
| `write_file`               | `path`, `content`                             | `path`                              |
| `read_file`                | `path`                                        | `path`, `content`                   |
| `list_files`               | `path` (default `.`)                          | `entries`, `truncated`              |
| `start_background_command` | `command`, `cwd`, `envs`, `timeoutMs`, `port` | `pid`, `preview_url`, `readiness`   |

`run_code` takes `python` (default), `javascript`, `typescript`, `r`, `java` or `bash`, with one kernel per language per sandbox.

- `success: true` means the operation ran. Code that raises returns an `error`; a nonzero exit returns `exit_code`.
- `success: false` means it could not run, for example invalid arguments or a transport failure. The agent loop keeps going.
- The call that creates a workspace returns `workspace: "new"`. If the sandbox expired, the next call returns `workspace_expired: true`, and the call after it starts an empty workspace.

Tell the model to check these fields.

## Sessions and cleanup

Workspaces are keyed by ADK session (`appName`, `userId` and session `id`). The key is stored in the sandbox metadata, so any server instance, including a restarted one, finds the conversation's sandbox and connects to it. Several instances behind a load balancer can serve one conversation without session affinity.

- **ADK's `close()` does not release a workspace.** ADK calls it after every run without saying which one ended, so the toolset treats it as a no-op.
- **Release sessions yourself.** Call `destroySession(session)` when a conversation ends, and `destroyAll()` on shutdown.
- **Billing.** A sandbox is billed from its first tool call until it is destroyed or times out. The default idle timeout is five minutes.

Set `namespace` when staging and production share one E2B API key and app name, so each deployment finds only its own sandboxes.

## Configuration

```typescript
const toolset = new E2BToolset({
  template: 'your-template',
  namespace: 'production',
  maxOperationMs: 600_000,
  sandboxOptions: {
    timeoutMs: 300_000,
    lifecycle: { onTimeout: 'pause', autoResume: true },
    metadata: { application: 'analyst' },
    allowInternetAccess: false,
  },
})
```

- `template`: E2B template. It must include the interpreters you use and util-linux `setsid`.
- `sandboxOptions`: the E2B SDK creation options, except `template`. Unset options keep the SDK defaults.
- `maxOperationMs`: upper bound for one `run_code` or `run_command`, default 10 minutes. The model's `timeoutMs` cannot exceed it.
- `namespace`: separates deployments that share an API key and app name.

With `lifecycle: { onTimeout: 'pause' }`, an idle sandbox is paused and resumed by the next call in its session, with files and kernel state intact. Paused sandboxes are not billed, but they stay until destroyed, so use pause only if your application calls `destroySession()`.

## Direct code executor

`E2BCodeExecutor` implements ADK's `BaseCodeExecutor` for direct `executeCode()` calls. It keeps kernel state until `close()`. See the [direct executor example](examples/code-executor.ts).

Setting `LlmAgent({ codeExecutor })` alone does not run model-generated code in ADK 2.1.0. Use `E2BToolset` for an autonomous agent.

## Examples and development

- [Data analysis agent](examples/data-analysis.ts): two messages in one conversation; the CSV saved by the first is reused by the second.
- [Direct code executor](examples/code-executor.ts)

```bash
pnpm install --frozen-lockfile
pnpm check
```

Unit tests use real ADK objects with mocked models and E2B SDK calls, so CI needs no credentials. Live checks use real E2B sandboxes and a model. Copy `.env.example` to `.env`, then run `pnpm test:live`. They are never part of `pnpm check` or CI.
