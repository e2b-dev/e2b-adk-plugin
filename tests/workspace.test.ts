import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandExitError,
  FileNotFoundError,
  SandboxNotFoundError,
  TimeoutError,
  type Sandbox,
} from '@e2b/code-interpreter'
import {
  OperationAbortedError,
  WorkspaceBlockedError,
  WorkspaceDestroyedError,
  WorkspaceExpiredError,
} from '../src/results.js'
import { Workspace } from '../src/workspace.js'
import { deferred, execution, mockSandbox, tick } from './helpers.js'

afterEach(() => vi.useRealTimers())

const info = () => ({ created: false })
const workspace = (options = {}) => new Workspace(options, 'Retry destroy.')

describe('workspace lifecycle', () => {
  it('is lazy, forwards only supplied SDK options and reports creation', async () => {
    const { create, sandbox } = mockSandbox()
    const options = {
      timeoutMs: 1200,
      allowInternetAccess: false,
      lifecycle: { onTimeout: 'pause' as const, autoResume: true },
    }
    const ws = workspace({ template: 'custom', sandboxOptions: options })
    expect(create).not.toHaveBeenCalled()
    const first = info()
    await ws.run(async () => 1, first)
    expect(first.created).toBe(true)
    expect(create).toHaveBeenCalledWith('custom', options)
    const second = info()
    await ws.run(async () => 1, second)
    expect(second.created).toBe(false)
    expect(create).toHaveBeenCalledTimes(1)
    expect(sandbox.setTimeout).toHaveBeenCalledWith(1200)
    expect(sandbox.kill).not.toHaveBeenCalled()
  })

  it('serializes work; a cancelled waiter has no SDK effect and does not let the next one overtake', async () => {
    const { sandbox } = mockSandbox()
    const ws = workspace()
    const gate = deferred<void>()
    const order: string[] = []
    const a = ws.run(async () => {
      order.push('a')
      await gate.promise
      order.push('a done')
    }, info())
    const cancel = new AbortController()
    const skipped = vi.fn()
    const b = ws.run(skipped, info(), cancel.signal)
    const c = ws.run(async () => order.push('c'), info())
    await tick()
    cancel.abort()
    await expect(b).rejects.toBeInstanceOf(OperationAbortedError)
    await tick()
    expect(order).toEqual(['a'])
    gate.resolve()
    await Promise.all([a, c])
    expect(order).toEqual(['a', 'a done', 'c'])
    expect(skipped).not.toHaveBeenCalled()
    expect(sandbox.restartCodeContext).not.toHaveBeenCalled()
    expect(sandbox.commands.run).not.toHaveBeenCalled()
  })

  it('starts an operation deadline when it is served, not when it is queued', async () => {
    vi.useFakeTimers()
    const { sandbox } = mockSandbox()
    sandbox.runCode.mockImplementation(
      () =>
        new Promise((resolve) => setTimeout(() => resolve(execution()), 2000)),
    )
    const ws = workspace()
    const first = ws.run(
      () => new Promise((resolve) => setTimeout(resolve, 5000)),
      info(),
    )
    const queued = ws.runCode('x', 'python', undefined, info(), {
      timeoutMs: 3000,
    })
    await vi.advanceTimersByTimeAsync(8000)
    await first
    expect(await queued).toHaveProperty('execution')
    expect(sandbox.restartCodeContext).not.toHaveBeenCalled()
  })

  it('uses one lazy code context per language and never passes language with it', async () => {
    const { sandbox } = mockSandbox()
    const ws = workspace()
    await ws.runCode('a', 'python', { X: '1' }, info(), { timeoutMs: 1000 })
    await ws.runCode('b', 'python', undefined, info(), { timeoutMs: 1000 })
    await ws.runCode('c', 'r', undefined, info(), { timeoutMs: 1000 })
    expect(sandbox.createCodeContext.mock.calls).toEqual([
      [{ language: 'python' }],
      [{ language: 'r' }],
    ])
    expect(sandbox.runCode).toHaveBeenNthCalledWith(1, 'a', {
      context: { id: 'ctx-python', language: 'python', cwd: '/home/user' },
      envs: { X: '1' },
      timeoutMs: 6000,
    })
  })

  it.each([
    ['deadline', 'timed_out'],
    ['abort', 'aborted'],
    ['SDK timeout', 'timed_out'],
  ])(
    '%s during code restarts the kernel before the next call',
    async (how, stopped) => {
      vi.useFakeTimers()
      const { sandbox } = mockSandbox()
      const running = deferred<never>()
      running.promise.catch(() => undefined)
      sandbox.runCode.mockReturnValueOnce(running.promise)
      // Live-verified: a restart ends the open execution stream.
      sandbox.restartCodeContext.mockImplementation(async () =>
        running.reject(new Error('UnexpectedEndOfExecution')),
      )
      const ws = workspace()
      const abort = new AbortController()
      const result = ws.runCode('loop', 'python', undefined, info(), {
        timeoutMs: 1000,
        signal: abort.signal,
      })
      await vi.advanceTimersByTimeAsync(10)
      if (how === 'abort') abort.abort()
      if (how === 'SDK timeout') running.reject(new TimeoutError('timed out'))
      await vi.advanceTimersByTimeAsync(1000)
      expect(await result).toEqual({ stopped })
      expect(sandbox.restartCodeContext).toHaveBeenCalledWith({
        id: 'ctx-python',
        language: 'python',
        cwd: '/home/user',
      })
      const next = ws.runCode('1', 'python', undefined, info(), {
        timeoutMs: 1000,
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(await next).toHaveProperty('execution')
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('blocks the workspace when a kernel restart fails, until destroy recovers it', async () => {
    const { sandbox, create } = mockSandbox()
    sandbox.runCode.mockRejectedValueOnce(new TimeoutError('timed out'))
    sandbox.restartCodeContext.mockRejectedValueOnce(new Error('down'))
    const ws = workspace()
    await expect(
      ws.runCode('loop', 'java', undefined, info(), { timeoutMs: 1000 }),
    ).rejects.toThrow('The java kernel could not be restarted')
    const skipped = vi.fn()
    await expect(ws.run(skipped, info())).rejects.toBeInstanceOf(
      WorkspaceBlockedError,
    )
    expect(skipped).not.toHaveBeenCalled()
    await ws.destroy()
    const later = info()
    await ws.run(async () => 1, later)
    expect(later.created).toBe(true)
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('runs commands in their own process group without passing the abort signal to the SDK', async () => {
    const { sandbox } = mockSandbox()
    const ws = workspace()
    const abort = new AbortController()
    const outcome = await ws.runCommand(
      "echo 'hi'",
      { cwd: '/tmp', envs: { X: 'y' } },
      info(),
      { timeoutMs: 1000, signal: abort.signal },
    )
    expect(outcome).toEqual({
      result: { stdout: 'ok', stderr: '', exitCode: 0 },
    })
    expect(sandbox.commands.run).toHaveBeenCalledWith(
      `exec setsid -w /bin/bash -c 'echo '\\''hi'\\'''`,
      { cwd: '/tmp', envs: { X: 'y' }, background: true, timeoutMs: 0 },
    )
    const exit = new CommandExitError({
      stdout: 'out',
      stderr: 'err',
      exitCode: 7,
      error: 'failed',
    })
    sandbox.handle.wait.mockRejectedValueOnce(exit)
    expect(
      await ws.runCommand('exit 7', {}, info(), { timeoutMs: 1000 }),
    ).toEqual({ result: exit })
  })

  it.each(['deadline', 'abort', 'abort before the handle exists'])(
    '%s kills the command process group',
    async (how) => {
      vi.useFakeTimers()
      const { sandbox } = mockSandbox()
      const exited = deferred<never>()
      exited.promise.catch(() => undefined)
      sandbox.handle.wait.mockReturnValueOnce(exited.promise)
      Object.assign(sandbox.handle, { stdout: 'partial', stderr: '' })
      const start = deferred<typeof sandbox.handle>()
      sandbox.commands.run.mockImplementation(async (command, opts) => {
        if (opts?.background) return start.promise
        if (command === 'kill -9 -- -101') exited.reject(new Error('killed'))
        return { stdout: '', stderr: '', exitCode: 0 }
      })
      const abort = new AbortController()
      const ws = workspace()
      const result = ws.runCommand('sleep 600', {}, info(), {
        timeoutMs: 1000,
        signal: abort.signal,
      })
      await vi.advanceTimersByTimeAsync(10)
      if (how === 'abort before the handle exists') abort.abort()
      start.resolve(sandbox.handle)
      await vi.advanceTimersByTimeAsync(10)
      if (how === 'abort') abort.abort()
      await vi.advanceTimersByTimeAsync(1000)
      const stopped = how === 'deadline' ? 'timed_out' : 'aborted'
      expect(await result).toEqual({ stopped, stdout: 'partial', stderr: '' })
      expect(sandbox.commands.run).toHaveBeenCalledWith('kill -9 -- -101')
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('falls back to killing the command itself when the group kill fails', async () => {
    vi.useFakeTimers()
    const { sandbox } = mockSandbox()
    const exited = deferred<never>()
    exited.promise.catch(() => undefined)
    sandbox.handle.wait.mockReturnValueOnce(exited.promise)
    sandbox.handle.kill.mockImplementation(async () => {
      exited.reject(new Error('killed'))
      return true
    })
    sandbox.commands.run.mockImplementation(async (_command, opts) => {
      if (opts?.background) return sandbox.handle
      throw new Error('no such group')
    })
    const result = workspace().runCommand('x', {}, info(), { timeoutMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(await result).toMatchObject({ stopped: 'timed_out' })
    expect(sandbox.handle.kill).toHaveBeenCalledTimes(1)
  })

  it('destroy fails queued work without recreating, rejects new work meanwhile, then allows a new workspace', async () => {
    const { sandbox, create } = mockSandbox()
    const ws = workspace()
    await ws.run(async () => 1, info())
    const gate = deferred<void>()
    const running = ws.run(() => gate.promise, info())
    const queuedWork = vi.fn()
    const queued = ws.run(queuedWork, info())
    const kill = deferred<boolean>()
    sandbox.kill.mockReturnValueOnce(kill.promise)
    const destroy = ws.destroy()
    expect(ws.destroy()).toBe(destroy)
    await expect(ws.run(async () => 1, info())).rejects.toBeInstanceOf(
      WorkspaceDestroyedError,
    )
    kill.resolve(true)
    await destroy
    gate.resolve()
    await expect(running).rejects.toBeInstanceOf(WorkspaceDestroyedError)
    await expect(queued).rejects.toBeInstanceOf(WorkspaceDestroyedError)
    expect(queuedWork).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledTimes(1)
    expect(ws.idle).toBe(true)
    const later = info()
    await ws.run(async () => 1, later)
    expect(later.created).toBe(true)
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('kills a sandbox whose creation finished after destroy', async () => {
    const { sandbox, create } = mockSandbox()
    const pending = deferred<Sandbox>()
    create.mockReturnValueOnce(pending.promise)
    const ws = workspace()
    const work = vi.fn()
    const first = ws.run(work, info())
    await tick()
    await ws.destroy()
    pending.resolve(sandbox as unknown as Sandbox)
    await expect(first).rejects.toBeInstanceOf(WorkspaceDestroyedError)
    expect(work).not.toHaveBeenCalled()
    expect(sandbox.kill).toHaveBeenCalledTimes(1)
    expect(ws.idle).toBe(true)
  })

  it('keeps a failed kill handle blocked and retryable', async () => {
    const { sandbox, create } = mockSandbox()
    const ws = workspace()
    await ws.run(async () => 1, info())
    sandbox.kill.mockRejectedValueOnce(new Error('Unavailable'))
    await expect(ws.destroy()).rejects.toThrow(
      'Sandbox cleanup failed. Retry destroy.',
    )
    const work = vi.fn()
    const renewals = sandbox.setTimeout.mock.calls.length
    await expect(ws.run(work, info())).rejects.toThrow('Retry destroy.')
    expect(work).not.toHaveBeenCalled()
    expect(sandbox.setTimeout).toHaveBeenCalledTimes(renewals)
    expect(ws.idle).toBe(false)
    await ws.destroy()
    expect(sandbox.kill).toHaveBeenCalledTimes(2)
    await ws.run(async () => 1, info())
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('reports an expired sandbox once, resets code contexts, then starts a new workspace', async () => {
    const { sandbox, create } = mockSandbox()
    const ws = workspace()
    await ws.runCode('x = 1', 'python', undefined, info(), { timeoutMs: 1000 })
    sandbox.setTimeout.mockRejectedValueOnce(new SandboxNotFoundError('gone'))
    sandbox.connect.mockRejectedValueOnce(new SandboxNotFoundError('gone'))
    const work = vi.fn()
    await expect(ws.run(work, info())).rejects.toBeInstanceOf(
      WorkspaceExpiredError,
    )
    expect(work).not.toHaveBeenCalled()
    const next = info()
    await ws.runCode('x', 'python', undefined, info(), { timeoutMs: 1000 })
    await ws.run(async () => 1, next)
    expect(create).toHaveBeenCalledTimes(2)
    expect(sandbox.createCodeContext).toHaveBeenCalledTimes(2)
  })

  it('resumes a paused sandbox, which the control plane also reports as missing', async () => {
    const { sandbox, create } = mockSandbox()
    const ws = workspace({ sandboxOptions: { timeoutMs: 1200 } })
    await ws.runCode('x = 1', 'python', undefined, info(), { timeoutMs: 1000 })
    sandbox.setTimeout.mockRejectedValueOnce(new SandboxNotFoundError('paused'))
    const resumed = info()
    expect(await ws.run(async () => 'kept', resumed)).toBe('kept')
    expect(sandbox.connect).toHaveBeenCalledWith({ timeoutMs: 1200 })
    expect(resumed.created).toBe(false)
    await ws.runCode('x', 'python', undefined, info(), { timeoutMs: 1000 })
    expect(create).toHaveBeenCalledTimes(1)
    expect(sandbox.createCodeContext).toHaveBeenCalledTimes(1)
    sandbox.setTimeout.mockRejectedValueOnce(new SandboxNotFoundError('paused'))
    sandbox.connect.mockRejectedValueOnce(new Error('Transient'))
    await expect(ws.run(async () => 1, info())).rejects.toThrow('Transient')
    expect(await ws.run(async () => 2, info())).toBe(2)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('does not treat a missing file or other refresh failure as expiry', async () => {
    const { sandbox, create } = mockSandbox()
    const ws = workspace()
    await ws.run(async () => 1, info())
    await expect(
      ws.run(async () => {
        throw new FileNotFoundError('missing')
      }, info()),
    ).rejects.toBeInstanceOf(FileNotFoundError)
    sandbox.setTimeout.mockRejectedValue(new Error('Transient'))
    expect(await ws.run(async () => 42, info())).toBe(42)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('refreshes throughout operations exceeding TTL and stops when they end', async () => {
    vi.useFakeTimers()
    const { sandbox } = mockSandbox()
    const ws = workspace({ sandboxOptions: { timeoutMs: 1000 } })
    await ws.run(async () => 1, info())
    const calls = sandbox.setTimeout.mock.calls.length
    const finish = deferred<number>()
    const work = ws.run(() => finish.promise, info())
    await vi.advanceTimersByTimeAsync(2500)
    expect(sandbox.setTimeout.mock.calls.length - calls).toBe(6)
    const rejected = expect(work).rejects.toThrow('Execution failed')
    finish.reject(new Error('Execution failed'))
    await rejected
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sandbox.setTimeout.mock.calls.length - calls).toBe(7)
  })
})
