import { describe, expect, it } from 'vitest'
import type { Sandbox } from '@e2b/code-interpreter'
import {
  Context,
  InMemoryRunner,
  LlmAgent,
  type Event,
  type LlmResponse,
} from '@google/adk'
import { E2BToolset } from '../src/index.js'
import { context, mockSandbox, ScriptedModel } from './helpers.js'

const done: LlmResponse = {
  content: { role: 'model', parts: [{ text: 'done' }] },
}
const call = (name: string, args: Record<string, unknown>): LlmResponse => ({
  content: { role: 'model', parts: [{ functionCall: { name, args } }] },
})
const write = call('write_file', { path: '/secret.txt', content: 'alice-data' })
const read = call('read_file', { path: '/secret.txt' })
const message = { role: 'user', parts: [{ text: 'test' }] }
function runner(toolset: E2BToolset, responses: LlmResponse[]) {
  return new InMemoryRunner({
    agent: new LlmAgent({
      name: 'agent',
      model: new ScriptedModel(responses),
      tools: [toolset],
    }),
  })
}
async function response(stream: AsyncGenerator<Event, void, unknown>) {
  for (;;) {
    const event = await stream.next()
    if (event.done) throw new Error('Missing tool response')
    const result = event.value.content?.parts?.find((p) => p.functionResponse)
      ?.functionResponse?.response
    if (result) return result
  }
}
async function drain(stream: AsyncGenerator<Event, void, unknown>) {
  const events: Event[] = []
  for await (const event of stream) events.push(event)
  return events
}

describe('invocation isolation', () => {
  it('allows sequential invocations in the same session with fresh workspaces', async () => {
    const { create, sandbox } = mockSandbox()
    const app = runner(new E2BToolset(), [write, done, write, done])
    const session = await app.sessionService.createSession({
      appName: app.appName,
      userId: 'alice',
    })
    for (let i = 0; i < 2; i++) {
      await drain(
        app.runAsync({
          userId: 'alice',
          sessionId: session.id,
          newMessage: message,
        }),
      )
    }
    expect(create).toHaveBeenCalledTimes(2)
    expect(sandbox.kill).toHaveBeenCalledTimes(2)
  })

  it.each([false, true])(
    'fails closed for overlapping runs (same session: %s)',
    async (sameSession) => {
      const { sandbox, create } = mockSandbox()
      const toolset = new E2BToolset()
      const app = runner(toolset, [write, read, done])
      const session = await app.sessionService.createSession({
        appName: app.appName,
        userId: 'alice',
      })
      const alice = app.runAsync({
        userId: 'alice',
        sessionId: session.id,
        newMessage: message,
      })
      expect((await response(alice)).success).toBe(true)
      const bob = sameSession
        ? app.runAsync({
            userId: 'alice',
            sessionId: session.id,
            newMessage: message,
          })
        : app.runEphemeral({ userId: 'bob', newMessage: message })
      // Discovery rejects the second invocation even if it never calls a tool.
      await expect(drain(bob)).rejects.toThrow('overlapping invocations')
      expect(sandbox.files.read).not.toHaveBeenCalled()
      expect(sandbox.kill).toHaveBeenCalledTimes(1)
      await expect(drain(alice)).rejects.toThrow('overlapping invocations')
      expect(create).toHaveBeenCalledTimes(1)
      await toolset.close()
      await expect(
        drain(app.runEphemeral({ userId: 'later', newMessage: message })),
      ).rejects.toThrow('overlapping invocations')
      expect(create).toHaveBeenCalledTimes(1)
    },
  )

  it('does not expose a previous user workspace after Runner swallows a failed kill', async () => {
    const { sandbox, create } = mockSandbox()
    sandbox.kill.mockRejectedValueOnce(new Error('secret SDK request'))
    const toolset = new E2BToolset()
    const app = runner(toolset, [write, done, read, done, write, done])
    await drain(app.runEphemeral({ userId: 'alice', newMessage: message }))
    const bob = app.runEphemeral({ userId: 'bob', newMessage: message })
    expect(await response(bob)).toMatchObject({
      success: false,
      error: expect.stringContaining('Retry close()'),
    })
    expect(sandbox.files.read).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledTimes(1)
    await drain(bob) // Cleanup retries the retained handle successfully.
    expect(sandbox.kill).toHaveBeenCalledTimes(2)
    await drain(app.runEphemeral({ userId: 'carol', newMessage: message }))
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('does not reopen after an unrelated runner closes the toolset without discovering tools', async () => {
    const { sandbox, create } = mockSandbox()
    const toolset = new E2BToolset()
    const aliceRunner = runner(toolset, [write, read, done])
    const alice = aliceRunner.runEphemeral({
      userId: 'alice',
      newMessage: message,
    })
    await response(alice)
    const bobRunner = new InMemoryRunner({
      agent: new LlmAgent({
        name: 'short_circuit',
        model: new ScriptedModel([]),
        tools: [toolset],
        beforeAgentCallback: () => done.content,
      }),
    })
    await drain(bobRunner.runEphemeral({ userId: 'bob', newMessage: message }))
    expect(sandbox.kill).toHaveBeenCalledTimes(1)
    await expect(drain(alice)).rejects.toThrow('was closed')
    expect(sandbox.files.read).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('rejects late calls and cloned contexts after close without reopening or disturbing a newer run', async () => {
    const { sandbox, create } = mockSandbox()
    const toolset = new E2BToolset()
    const tools = await toolset.getTools()
    const readTool = tools.find((t) => t.name === 'read_file')!
    const alice = context('alice')
    const invoke = (ctx: typeof alice) =>
      readTool.runAsync({
        args: { path: '/secret.txt' },
        toolContext: new Context({ invocationContext: ctx }),
      })
    await invoke(alice)
    await toolset.close()
    await invoke(context('bob'))
    await toolset.close()
    expect(await invoke(alice.clone())).toMatchObject({
      success: false,
      error: expect.stringContaining('was closed'),
    })
    expect(create).toHaveBeenCalledTimes(2)
    expect(sandbox.files.read).toHaveBeenCalledTimes(2)
  })

  it('guards individual tools even when getTools is called without a context', async () => {
    const { create, sandbox } = mockSandbox()
    const toolset = new E2BToolset()
    const readTool = (await toolset.getTools()).find(
      (t) => t.name === 'read_file',
    )!
    const invoke = (user: string) =>
      readTool.runAsync({
        args: { path: '/secret.txt' },
        toolContext: new Context({ invocationContext: context(user, user) }),
      })
    expect(await invoke('alice')).toMatchObject({ success: true })
    expect(await invoke('bob')).toMatchObject({
      success: false,
      error: expect.stringContaining('overlapping invocations'),
    })
    expect(await invoke('alice')).toMatchObject({ success: false })
    expect(sandbox.files.read).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledTimes(1)
    await toolset.close()
  })

  it('keeps separate concurrent instances independent', async () => {
    const { sandbox, create } = mockSandbox()
    // Separate in-memory SDK workspaces make data isolation observable.
    create.mockImplementation(async () => {
      const files = new Map<string, string>()
      let killed = false
      return {
        ...sandbox,
        files: {
          ...sandbox.files,
          write: async (path: string, value: string) => {
            expect(killed).toBe(false)
            files.set(path, value)
          },
          read: async (path: string) => {
            expect(killed).toBe(false)
            if (!files.has(path)) throw new Error('Not found')
            return files.get(path)!
          },
        },
        kill: async () => {
          killed = true
          return true
        },
      } as unknown as Sandbox
    })
    const aliceRunner = runner(new E2BToolset(), [write, read, done])
    const bobRunner = runner(new E2BToolset(), [read, done])
    const alice = aliceRunner.runEphemeral({
      userId: 'alice',
      newMessage: message,
    })
    await response(alice)
    const bob = bobRunner.runEphemeral({ userId: 'bob', newMessage: message })
    expect((await response(bob)).success).toBe(false)
    await drain(bob)
    expect(await response(alice)).toMatchObject({
      success: true,
      content: 'alice-data',
    })
    await drain(alice)
    expect(create).toHaveBeenCalledTimes(2)
  })
})
