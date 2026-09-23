import { describe, expect, it } from 'vitest'
import {
  FunctionTool,
  InMemoryRunner,
  InvocationContext,
  LlmAgent,
  PluginManager,
  type LlmResponse,
} from '@google/adk'
import { z } from 'zod'
import { E2BToolset } from '../src/index.js'
import {
  deferred,
  drain,
  mockSandbox,
  plan,
  PlanModel,
  ScriptedModel,
  statefulSandboxes,
  tick,
  toolContext,
  toolResponses,
} from './helpers.js'

const write = (content: string) => ({
  name: 'write_file',
  args: { path: '/home/user/data.txt', content },
})
const read = { name: 'read_file', args: { path: '/home/user/data.txt' } }

/** The adk web / api_server pattern: one module-level agent for every user. */
function app(toolset = new E2BToolset()) {
  const runner = new InMemoryRunner({
    agent: new LlmAgent({
      name: 'agent',
      model: new PlanModel(),
      tools: [toolset],
    }),
  })
  const session = (userId: string) =>
    runner.sessionService.createSession({ appName: runner.appName, userId })
  const ask = async (
    s: { id: string; userId: string },
    message: ReturnType<typeof plan>,
  ) =>
    toolResponses(
      await drain(
        runner.runAsync({
          userId: s.userId,
          sessionId: s.id,
          newMessage: message,
        }),
      ),
    )
  return { runner, toolset, session, ask }
}

function invocation(sessionId: string, invocationId: string) {
  return toolContext(
    new InvocationContext({
      invocationId,
      pluginManager: new PluginManager(),
      session: {
        id: sessionId,
        userId: 'user',
        appName: 'test',
        state: {},
        events: [],
        lastUpdateTime: 0,
      },
    }),
  )
}

describe('session-scoped workspaces', () => {
  it('gives concurrent sessions of a module-level agent separate sandboxes, and later sessions still work', async () => {
    const { create } = mockSandbox()
    const boxes = statefulSandboxes(create)
    const { session, ask } = app()
    const [alice, bob] = await Promise.all([session('alice'), session('bob')])
    const [a, b] = await Promise.all([
      ask(alice, plan(write('alice-data'), read)),
      ask(bob, plan(write('bob-data'), read)),
    ])
    expect(a[1]).toMatchObject({ success: true, content: 'alice-data' })
    expect(b[1]).toMatchObject({ success: true, content: 'bob-data' })
    expect(create).toHaveBeenCalledTimes(2)
    const carol = await session('carol')
    expect((await ask(carol, plan(read)))[0]).toEqual({
      success: false,
      error: 'Sandbox operation failed (FileNotFoundError).',
      workspace: 'new',
    })
    expect(create).toHaveBeenCalledTimes(3)
    // ADK closed the toolset after each run; nothing was killed.
    expect(boxes.map((box) => box.kill.mock.calls.length)).toEqual([0, 0, 0])
  })

  it('keeps files and kernels across messages of one session', async () => {
    const { create, sandbox } = mockSandbox()
    const { session, ask } = app()
    const s = await session('alice')
    const first = await ask(
      s,
      plan(write('x'), { name: 'run_code', args: { code: 'n = 1' } }),
    )
    expect(first[0]).toMatchObject({ workspace: 'new' })
    const second = await ask(
      s,
      plan(read, { name: 'run_code', args: { code: 'n' } }),
    )
    expect(second.every((r) => r.success && !('workspace' in r))).toBe(true)
    expect(create).toHaveBeenCalledTimes(1)
    expect(sandbox.createCodeContext).toHaveBeenCalledTimes(1)
    expect(sandbox.kill).not.toHaveBeenCalled()
  })

  it('keeps the workspace through a tool-confirmation pause', async () => {
    const { create } = mockSandbox()
    statefulSandboxes(create)
    const deploy = new FunctionTool({
      name: 'deploy',
      description: 'deploy',
      parameters: z.object({}),
      requireConfirmation: true,
      execute: async () => ({ ok: true }),
    })
    const call = (
      name: string,
      args: Record<string, unknown>,
      id: string,
    ): LlmResponse => ({
      content: { role: 'model', parts: [{ functionCall: { name, args, id } }] },
    })
    const done: LlmResponse = {
      content: { role: 'model', parts: [{ text: 'done' }] },
    }
    const runner = new InMemoryRunner({
      agent: new LlmAgent({
        name: 'agent',
        model: new ScriptedModel([
          call('write_file', write('artifact').args, 'w1'),
          call('deploy', {}, 'd1'),
          call('read_file', read.args, 'r1'),
          done,
        ]),
        tools: [new E2BToolset(), deploy],
      }),
    })
    const s = await runner.sessionService.createSession({
      appName: runner.appName,
      userId: 'u',
    })
    const first = await drain(
      runner.runAsync({ userId: 'u', sessionId: s.id, newMessage: plan() }),
    )
    const confirm = first
      .flatMap((e) => e.content?.parts ?? [])
      .find(
        (p) => p.functionCall?.name === 'adk_request_confirmation',
      )?.functionCall
    expect(confirm).toBeDefined()
    const second = await drain(
      runner.runAsync({
        userId: 'u',
        sessionId: s.id,
        newMessage: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: confirm!.id,
                name: confirm!.name,
                response: { confirmed: true },
              },
            },
          ],
        },
      }),
    )
    expect(toolResponses(second)).toContainEqual({
      success: true,
      path: '/home/user/data.txt',
      content: 'artifact',
    })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('serializes overlapping invocations of one session in one shared sandbox', async () => {
    const { create, sandbox } = mockSandbox()
    let active = 0
    let overlap = false
    sandbox.files.write.mockImplementation(async () => {
      overlap ||= ++active > 1
      await tick()
      active--
      return { path: 'x' }
    })
    const toolset = new E2BToolset()
    const tool = (await toolset.getTools())[2]!
    const results = await Promise.all(
      ['inv-1', 'inv-2', 'inv-1', 'inv-2'].map((id, i) =>
        tool.runAsync({
          args: { path: `/f${i}`, content: 'x' },
          toolContext: invocation('shared', id),
        }),
      ),
    )
    expect(results.every((r) => (r as { success: boolean }).success)).toBe(true)
    expect(overlap).toBe(false)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('a late ADK close() from another run does not disturb active work', async () => {
    const { sandbox } = mockSandbox()
    const slow = deferred<string>()
    sandbox.files.read.mockReturnValue(slow.promise)
    const toolset = new E2BToolset()
    const tool = (await toolset.getTools())[3]!
    const active = tool.runAsync({
      args: { path: '/a' },
      toolContext: invocation('s', 'new'),
    })
    await tick()
    await toolset.close()
    slow.resolve('still here')
    expect(await active).toMatchObject({ success: true, content: 'still here' })
    expect(sandbox.kill).not.toHaveBeenCalled()
  })

  it('destroySession releases only that session; later messages start a new workspace', async () => {
    const { create } = mockSandbox()
    const boxes = statefulSandboxes(create)
    const { session, ask, toolset } = app()
    const [alice, bob] = await Promise.all([session('alice'), session('bob')])
    await ask(alice, plan(write('a')))
    await ask(bob, plan(write('b')))
    await toolset.destroySession(alice)
    expect(boxes[0]!.kill).toHaveBeenCalledTimes(1)
    expect(boxes[1]!.kill).not.toHaveBeenCalled()
    await toolset.destroySession(alice)
    expect(boxes[0]!.kill).toHaveBeenCalledTimes(1)
    expect((await ask(alice, plan(read)))[0]).toMatchObject({
      success: false,
      workspace: 'new',
    })
    expect((await ask(bob, plan(read)))[0]).toMatchObject({ content: 'b' })
  })

  it('destroySession fails queued work without recreating, and blocks until a failed kill is retried', async () => {
    const { create, sandbox } = mockSandbox()
    const toolset = new E2BToolset()
    const [, , writeTool, readTool] = await toolset.getTools()
    const ref = { appName: 'test', userId: 'user', id: 's' }
    await writeTool!.runAsync({
      args: { path: '/a', content: 'x' },
      toolContext: invocation('s', 'i'),
    })
    const slow = deferred<string>()
    sandbox.files.read.mockReturnValueOnce(slow.promise)
    const running = readTool!.runAsync({
      args: { path: '/a' },
      toolContext: invocation('s', 'i'),
    })
    const queued = readTool!.runAsync({
      args: { path: '/a' },
      toolContext: invocation('s', 'j'),
    })
    await tick()
    sandbox.kill.mockRejectedValueOnce(new Error('down'))
    await expect(toolset.destroySession(ref)).rejects.toThrow(
      'retry destroySession()',
    )
    slow.reject(new Error('sandbox killed'))
    expect(await running).toMatchObject({
      success: false,
      error: expect.stringContaining('released'),
    })
    expect(await queued).toMatchObject({
      success: false,
      error: expect.stringContaining('released'),
    })
    expect(
      await readTool!.runAsync({
        args: { path: '/a' },
        toolContext: invocation('s', 'k'),
      }),
    ).toMatchObject({
      success: false,
      error: expect.stringContaining('cleanup failed'),
    })
    expect(create).toHaveBeenCalledTimes(1)
    await toolset.destroySession(ref)
    expect(
      await readTool!.runAsync({
        args: { path: '/a' },
        toolContext: invocation('s', 'k'),
      }),
    ).toMatchObject({ success: true, workspace: 'new' })
  })

  it('destroyAll handles concurrent calls and partial failures', async () => {
    const { create } = mockSandbox()
    const boxes = statefulSandboxes(create)
    const toolset = new E2BToolset()
    const writeTool = (await toolset.getTools())[2]!
    for (const id of ['a', 'b', 'c'])
      await writeTool.runAsync({
        args: { path: '/x', content: id },
        toolContext: invocation(id, 'i'),
      })
    boxes[1]!.kill.mockRejectedValueOnce(new Error('down'))
    const [first, second] = await Promise.allSettled([
      toolset.destroyAll(),
      toolset.destroyAll(),
    ])
    expect(first.status).toBe('rejected')
    expect(second.status).toBe('rejected')
    expect(boxes.map((box) => box.kill.mock.calls.length)).toEqual([1, 1, 1])
    await toolset.destroyAll()
    expect(boxes.map((box) => box.kill.mock.calls.length)).toEqual([1, 2, 1])
    await toolset.destroyAll()
    expect(boxes.map((box) => box.kill.mock.calls.length)).toEqual([1, 2, 1])
  })
})
