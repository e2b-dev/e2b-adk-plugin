import { describe, expect, it } from 'vitest'
import {
  InMemoryRunner,
  LlmAgent,
  type Event,
  type LlmResponse,
} from '@google/adk'
import { E2BCodeExecutor, E2BToolset } from '../src/index.js'
import { mockSandbox, ScriptedModel } from './helpers.js'

const toolCall: LlmResponse = {
  content: {
    role: 'model',
    parts: [
      {
        functionCall: {
          id: 'call-1',
          name: 'run_code',
          args: { code: '6 * 7' },
        },
      },
    ],
  },
}
const done: LlmResponse = {
  content: { role: 'model', parts: [{ text: '42' }] },
}
const message = { role: 'user', parts: [{ text: 'Compute the answer.' }] }
async function collect(stream: AsyncGenerator<Event, void, unknown>) {
  const events: Event[] = []
  for await (const event of stream) events.push(event)
  return events
}

describe('real ADK runner integration', () => {
  it('routes tool calls; ADK close() after each run keeps the session workspace', async () => {
    const { sandbox, create } = mockSandbox()
    const toolset = new E2BToolset()
    const model = new ScriptedModel([toolCall, done, toolCall, done])
    const runner = new InMemoryRunner({
      agent: new LlmAgent({ name: 'agent', model, tools: [toolset] }),
    })
    const events = await collect(
      runner.runEphemeral({ userId: 'user', newMessage: message }),
    )
    expect(sandbox.runCode).toHaveBeenCalledWith('6 * 7', {
      context: { id: 'ctx-python', language: 'python', cwd: '/home/user' },
      envs: undefined,
      timeoutMs: 65_000,
    })
    expect(
      events
        .flatMap((e) => e.content?.parts ?? [])
        .some((p) => p.functionResponse?.name === 'run_code'),
    ).toBe(true)
    // runEphemeral uses a new session each time, so each gets a workspace.
    await collect(runner.runEphemeral({ userId: 'user', newMessage: message }))
    expect(create).toHaveBeenCalledTimes(2)
    expect(sandbox.kill).not.toHaveBeenCalled()
    await toolset.destroyAll()
    expect(sandbox.kill).toHaveBeenCalledTimes(2)
  })

  it('a model error after tool execution leaves the workspace for the application to release', async () => {
    const { sandbox } = mockSandbox()
    const toolset = new E2BToolset()
    const runner = new InMemoryRunner({
      agent: new LlmAgent({
        name: 'agent',
        model: new ScriptedModel([toolCall, new Error('Model failed')]),
        tools: [toolset],
      }),
    })
    const events = await collect(
      runner.runEphemeral({ userId: 'user', newMessage: message }),
    )
    expect(events.some((event) => event.errorMessage === 'Model failed')).toBe(
      true,
    )
    expect(sandbox.kill).not.toHaveBeenCalled()
    await toolset.destroyAll()
    expect(sandbox.kill).toHaveBeenCalledTimes(1)
  })

  it('forwards runner cancellation to a running command and kills its process group', async () => {
    const { sandbox } = mockSandbox()
    let exit!: (error: Error) => void
    sandbox.handle.wait.mockReturnValueOnce(
      new Promise((_, reject) => (exit = reject)),
    )
    sandbox.commands.run.mockImplementation(async (command, opts) => {
      if (opts?.background) return sandbox.handle
      if (command === 'kill -9 -- -101') exit(new Error('killed'))
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const model = new ScriptedModel([
      {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'c',
                name: 'run_command',
                args: { command: 'sleep 600' },
              },
            },
          ],
        },
      },
      done,
    ])
    const runner = new InMemoryRunner({
      agent: new LlmAgent({ name: 'agent', model, tools: [new E2BToolset()] }),
    })
    const session = await runner.sessionService.createSession({
      appName: runner.appName,
      userId: 'user',
    })
    const abort = new AbortController()
    const run = collect(
      runner.runAsync({
        userId: 'user',
        sessionId: session.id,
        newMessage: message,
        abortSignal: abort.signal,
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    abort.abort()
    await run
    expect(sandbox.commands.run).toHaveBeenCalledWith('kill -9 -- -101')
    expect(model.requests).toHaveLength(1)
  })

  it('returns validation errors to the model so it can correct a call', async () => {
    const { create } = mockSandbox()
    const badCall: LlmResponse = {
      content: {
        role: 'model',
        parts: [
          { functionCall: { id: 'bad', name: 'run_code', args: { code: 1 } } },
        ],
      },
    }
    const runner = new InMemoryRunner({
      agent: new LlmAgent({
        name: 'agent',
        model: new ScriptedModel([badCall, toolCall, done]),
        tools: [new E2BToolset()],
      }),
    })
    const events = await collect(
      runner.runEphemeral({ userId: 'user', newMessage: message }),
    )
    const responses = events
      .flatMap((e) => e.content?.parts ?? [])
      .filter((p) => p.functionResponse)
    expect(responses).toHaveLength(2)
    expect(JSON.stringify(responses[0])).toContain('"success":false')
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('documents that ADK 2.1.0 does not wire its code execution response processor', async () => {
    const { sandbox } = mockSandbox()
    const executor = new E2BCodeExecutor()
    const model = new ScriptedModel([
      {
        content: { role: 'model', parts: [{ text: '```python\n6 * 7\n```' }] },
      },
      done,
    ])
    const runner = new InMemoryRunner({
      agent: new LlmAgent({ name: 'agent', model, codeExecutor: executor }),
    })
    const events = await collect(
      runner.runEphemeral({ userId: 'user', newMessage: message }),
    )
    expect(events.filter((event) => event.errorCode)).toEqual([])
    expect(sandbox.runCode).not.toHaveBeenCalled()
    expect(
      events
        .flatMap((e) => e.content?.parts ?? [])
        .some((p) => p.codeExecutionResult),
    ).toBe(false)
    expect(sandbox.kill).not.toHaveBeenCalled()
    await executor.close()
    expect(sandbox.kill).not.toHaveBeenCalled()
  })

  it('does not reinterpret JavaScript fences as Python', async () => {
    const { create } = mockSandbox()
    const executor = new E2BCodeExecutor()
    const model = new ScriptedModel([
      {
        content: {
          role: 'model',
          parts: [{ text: '```javascript\nconsole.log(42)\n```' }],
        },
      },
    ])
    const runner = new InMemoryRunner({
      agent: new LlmAgent({ name: 'agent', model, codeExecutor: executor }),
    })
    await collect(runner.runEphemeral({ userId: 'user', newMessage: message }))
    expect(create).not.toHaveBeenCalled()
    await executor.close()
  })
})
