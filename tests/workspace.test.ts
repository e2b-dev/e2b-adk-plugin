import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandExitError,
  FileNotFoundError,
  InvalidArgumentError,
  NotFoundError,
  SandboxError,
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
import {
  deferred,
  execution,
  mockSandbox,
  statefulSandboxes,
  tick,
} from './helpers.js'

afterEach(() => vi.useRealTimers())

const info = () => ({ created: false })
const tag = { adkSessionId: 's' }
const workspace = (options = {}) =>
  new Workspace(options, 'Retry destroy.', tag)

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
    expect(create).toHaveBeenCalledWith('custom', {
      ...options,
      metadata: { adkSessionId: 's' },
    })
    const second = info()
    await ws.run(async () => 1, second)
    expect(second.created).toBe(false)
    expect(create).toHaveBeenCalledTimes(1)
    // Lifetime is extended through connect(), which never shortens it.
    expect(sandbox.connect).toHaveBeenCalledWith({ timeoutMs: 1200 })
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

  it('runs code in the sandbox default kernel of each language', async () => {
    const { sandbox } = mockSandbox()
    const ws = workspace()
    await ws.runCode('a', 'python', { X: '1' }, info(), { timeoutMs: 1000 })
    await ws.runCode('c', 'r', undefined, info(), { timeoutMs: 1000 })
    expect(sandbox.runCode).toHaveBeenNthCalledWith(1, 'a', {
      language: 'python',
      envs: { X: '1' },
      timeoutMs: 6000,
    })
    expect(sandbox.runCode).toHaveBeenNthCalledWith(2, 'c', {
      language: 'r',
      envs: undefined,
      timeoutMs: 6000,
    })
  })
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

  it('keeps a failed kill handle blocked and retryable', async () => {
    const { sandbox, create } = mockSandbox()
    const ws = workspace()
    await ws.run(async () => 1, info())
    sandbox.kill.mockRejectedValueOnce(new Error('Unavailable'))
    await expect(ws.destroy()).rejects.toThrow(
      'Sandbox cleanup failed. Retry destroy.',
    )
    const work = vi.fn()
    const renewals = sandbox.connect.mock.calls.length
    await expect(ws.run(work, info())).rejects.toThrow('Retry destroy.')
    expect(work).not.toHaveBeenCalled()
    expect(sandbox.connect).toHaveBeenCalledTimes(renewals)
    expect(ws.idle).toBe(false)
    await ws.destroy()
    expect(sandbox.kill).toHaveBeenCalledTimes(2)
    await ws.run(async () => 1, info())
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('reports an expired sandbox once, then starts a new workspace', async () => {
    const { sandbox, create, registry } = mockSandbox()
    const ws = workspace()
    await ws.runCode('x = 1', 'python', undefined, info(), { timeoutMs: 1000 })
    registry.kill(sandbox.sandboxId)
    const work = vi.fn()
    await expect(ws.run(work, info())).rejects.toBeInstanceOf(
      WorkspaceExpiredError,
    )
    expect(work).not.toHaveBeenCalled()
    const next = info()
    await ws.run(async () => 1, next)
    expect(next.created).toBe(true)
    expect(create).toHaveBeenCalledTimes(2)
  })
  it('resumes a paused sandbox instead of replacing it', async () => {
    const { sandbox, create, registry } = mockSandbox()
    const ws = workspace({ sandboxOptions: { timeoutMs: 1200 } })
    await ws.runCode('x = 1', 'python', undefined, info(), { timeoutMs: 1000 })
    registry.pause(sandbox.sandboxId)
    const resumed = info()
    expect(await ws.run(async () => 'kept', resumed)).toBe('kept')
    expect(sandbox.connect).toHaveBeenCalledWith({ timeoutMs: 1200 })
    expect(resumed.created).toBe(false)
    expect(registry.alive(sandbox.sandboxId)?.state).toBe('running')
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
    sandbox.connect.mockRejectedValue(new Error('Transient'))
    expect(await ws.run(async () => 42, info())).toBe(42)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('refreshes throughout operations exceeding TTL and stops when they end', async () => {
    vi.useFakeTimers()
    const { sandbox } = mockSandbox()
    const ws = workspace({ sandboxOptions: { timeoutMs: 1000 } })
    await ws.run(async () => 1, info())
    const calls = sandbox.connect.mock.calls.length
    const finish = deferred<number>()
    const work = ws.run(() => finish.promise, info())
    await vi.advanceTimersByTimeAsync(2500)
    expect(sandbox.connect.mock.calls.length - calls).toBe(6)
    const rejected = expect(work).rejects.toThrow('Execution failed')
    finish.reject(new Error('Execution failed'))
    await rejected
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sandbox.connect.mock.calls.length - calls).toBe(7)
  })
})

describe('cleanup and deadline boundaries', () => {
  const noSuchGroup = () =>
    new CommandExitError({
      stdout: '',
      stderr: 'bash: kill: (-101) - No such process\n',
      exitCode: 1,
      error: 'exit status 1',
    })

  it('destroy waits for an in-flight create and kills the late sandbox', async () => {
    const { sandbox, create } = mockSandbox()
    const pending = deferred<Sandbox>()
    create.mockReturnValueOnce(pending.promise)
    const ws = workspace()
    const work = vi.fn()
    const first = ws.run(work, info())
    await tick()
    let destroyed = false
    const destroy = ws.destroy().then(() => (destroyed = true))
    await tick()
    expect(destroyed).toBe(false)
    pending.resolve(sandbox as unknown as Sandbox)
    await destroy
    expect(sandbox.kill).toHaveBeenCalledTimes(1)
    await expect(first).rejects.toBeInstanceOf(WorkspaceDestroyedError)
    expect(work).not.toHaveBeenCalled()
  })

  it('keeps a late sandbox whose kill failed blocked and retryable', async () => {
    const { sandbox, create } = mockSandbox()
    const pending = deferred<Sandbox>()
    create.mockReturnValueOnce(pending.promise)
    sandbox.kill.mockRejectedValueOnce(new Error('network down'))
    const ws = workspace()
    const first = ws.run(async () => 1, info()).catch((error) => error)
    await tick()
    const destroy = ws.destroy()
    pending.resolve(sandbox as unknown as Sandbox)
    await expect(destroy).rejects.toThrow('Sandbox cleanup failed')
    expect(await first).toBeInstanceOf(WorkspaceDestroyedError)
    expect(ws.idle).toBe(false)
    const work = vi.fn()
    await expect(ws.run(work, info())).rejects.toThrow('Retry destroy.')
    expect(work).not.toHaveBeenCalled()
    await ws.destroy()
    expect(sandbox.kill).toHaveBeenCalledTimes(2)
    expect(ws.idle).toBe(true)
    await ws.run(async () => 2, info())
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('does not start an operation whose workspace was destroyed during the TTL refresh', async () => {
    const { sandbox } = mockSandbox()
    const ws = workspace()
    await ws.run(async () => 1, info())
    const refresh = deferred<void>()
    sandbox.connect.mockReturnValueOnce(refresh.promise)
    const effect = vi.fn(async () => 42)
    const run = ws.run(effect, info())
    await tick()
    await ws.destroy()
    refresh.resolve()
    await expect(run).rejects.toBeInstanceOf(WorkspaceDestroyedError)
    expect(effect).not.toHaveBeenCalled()
  })

  it('does not start an operation after a failed destroy blocked the live sandbox', async () => {
    const { sandbox } = mockSandbox()
    const ws = workspace()
    await ws.run(async () => 1, info())
    const refresh = deferred<void>()
    sandbox.connect.mockReturnValueOnce(refresh.promise)
    const effect = vi.fn(async () => 42)
    const run = ws.run(effect, info())
    await tick()
    sandbox.kill.mockRejectedValueOnce(new Error('down'))
    await expect(ws.destroy()).rejects.toThrow('Sandbox cleanup failed')
    refresh.resolve()
    await expect(run).rejects.toBeInstanceOf(WorkspaceDestroyedError)
    expect(effect).not.toHaveBeenCalled()
  })

  it('does not report success for an operation that finished after destroy', async () => {
    mockSandbox()
    const ws = workspace()
    const gate = deferred<number>()
    const run = ws.run(() => gate.promise, info())
    await tick()
    await tick()
    await ws.destroy()
    gate.resolve(42)
    await expect(run).rejects.toBeInstanceOf(WorkspaceDestroyedError)
  })

  it('blocks the workspace instead of trusting a leader-only kill when the group kill fails', async () => {
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
      throw new Error('network failure')
    })
    const ws = workspace()
    const run = ws
      .runCommand('loop', {}, info(), { timeoutMs: 100 })
      .catch((error) => error)
    await vi.advanceTimersByTimeAsync(100)
    const error = await run
    expect(error).toBeInstanceOf(WorkspaceBlockedError)
    expect(error.message).toContain('could not be confirmed')
    expect(sandbox.handle.kill).not.toHaveBeenCalled()
    const effect = vi.fn(async () => 42)
    await expect(ws.run(effect, info())).rejects.toBeInstanceOf(
      WorkspaceBlockedError,
    )
    expect(effect).not.toHaveBeenCalled()
    await ws.destroy()
    expect(await ws.run(effect, info())).toBe(42)
  })

  it('blocks the workspace when the command does not exit after its group was killed', async () => {
    vi.useFakeTimers()
    const { sandbox } = mockSandbox()
    sandbox.handle.wait.mockReturnValue(new Promise(() => {}))
    const ws = workspace()
    const run = ws
      .runCommand('loop', {}, info(), { timeoutMs: 100 })
      .catch((error) => error)
    await vi.advanceTimersByTimeAsync(31_000)
    expect(await run).toBeInstanceOf(WorkspaceBlockedError)
    await expect(ws.run(async () => 1, info())).rejects.toBeInstanceOf(
      WorkspaceBlockedError,
    )
  })

  it('treats "No such process" from the group kill as confirmed absence', async () => {
    vi.useFakeTimers()
    const { sandbox } = mockSandbox()
    const exited = deferred<never>()
    exited.promise.catch(() => undefined)
    sandbox.handle.wait.mockReturnValueOnce(exited.promise)
    sandbox.commands.run.mockImplementation(async (_command, opts) => {
      if (opts?.background) return sandbox.handle
      exited.reject(new Error('exited'))
      throw noSuchGroup()
    })
    const ws = workspace()
    const run = ws.runCommand('x', {}, info(), { timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    expect(await run).toMatchObject({ stopped: 'timed_out' })
    expect(await ws.run(async () => 1, info())).toBe(1)
  })

  it('counts a slow command start against the deadline and kills the late handle', async () => {
    vi.useFakeTimers()
    const { sandbox } = mockSandbox()
    const exited = deferred<never>()
    exited.promise.catch(() => undefined)
    sandbox.handle.wait.mockReturnValueOnce(exited.promise)
    const start = deferred<typeof sandbox.handle>()
    sandbox.commands.run.mockImplementation(async (command, opts) => {
      if (opts?.background) return start.promise
      if (command === 'kill -9 -- -101') exited.reject(new Error('killed'))
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const ws = workspace()
    let settled = false
    const run = ws
      .runCommand('echo x', {}, info(), { timeoutMs: 100 })
      .finally(() => (settled = true))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(settled).toBe(false)
    start.resolve(sandbox.handle)
    await vi.advanceTimersByTimeAsync(0)
    expect(await run).toMatchObject({ stopped: 'timed_out' })
    expect(sandbox.commands.run).toHaveBeenCalledWith('kill -9 -- -101')
  })

  it('blocks the workspace when a stopped command never delivers its handle, and kills it if it arrives', async () => {
    vi.useFakeTimers()
    const { sandbox } = mockSandbox()
    const start = deferred<typeof sandbox.handle>()
    sandbox.commands.run.mockImplementation(async (_command, opts) =>
      opts?.background
        ? start.promise
        : { stdout: '', stderr: '', exitCode: 0 },
    )
    const ws = workspace()
    const run = ws
      .runCommand('echo x', {}, info(), { timeoutMs: 100 })
      .catch((error) => error)
    await vi.advanceTimersByTimeAsync(31_000)
    expect(await run).toBeInstanceOf(WorkspaceBlockedError)
    await expect(ws.run(async () => 1, info())).rejects.toBeInstanceOf(
      WorkspaceBlockedError,
    )
    start.resolve(sandbox.handle)
    await vi.advanceTimersByTimeAsync(0)
    expect(sandbox.commands.run).toHaveBeenCalledWith('kill -9 -- -101')
  })

  it('does not claim a kernel restart when the deadline hits before the kernel exists', async () => {
    vi.useFakeTimers()
    const { sandbox } = mockSandbox()
    sandbox.runCode.mockReturnValueOnce(new Promise(() => {}))
    sandbox.listCodeContexts.mockResolvedValueOnce([])
    const ws = workspace()
    const run = ws.runCode('x', 'java', undefined, info(), { timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    expect(await run).toEqual({ stopped: 'timed_out', kernelRestarted: false })
    expect(sandbox.restartCodeContext).not.toHaveBeenCalled()
  })
})

describe('uncertain SDK outcomes', () => {
  const invalidCwd = () =>
    new InvalidArgumentError("[invalid_argument] cwd '/nope' does not exist")

  it('blocks the workspace when a command start fails ambiguously', async () => {
    const { sandbox } = mockSandbox()
    sandbox.commands.run.mockRejectedValueOnce(new TypeError('fetch failed'))
    const ws = workspace()
    await expect(
      ws.runCommand('x', {}, info(), { timeoutMs: 1000 }),
    ).rejects.toThrow('may still be running')
    const effect = vi.fn(async () => 1)
    await expect(ws.run(effect, info())).rejects.toBeInstanceOf(
      WorkspaceBlockedError,
    )
    expect(effect).not.toHaveBeenCalled()
    await ws.destroy()
    expect(await ws.run(effect, info())).toBe(1)
  })

  it('does not block after the server refuses to start a command', async () => {
    const { sandbox } = mockSandbox()
    sandbox.commands.run.mockRejectedValueOnce(invalidCwd())
    const ws = workspace()
    await expect(
      ws.runCommand('x', { cwd: '/nope' }, info(), { timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(InvalidArgumentError)
    expect(
      await ws.runCommand('x', { cwd: '/tmp' }, info(), { timeoutMs: 1000 }),
    ).toHaveProperty('result')
  })

  it('stops the group when an established command stream is lost, then reports the failure', async () => {
    const { sandbox } = mockSandbox()
    sandbox.handle.wait.mockRejectedValue(new SandboxError('stream lost'))
    const ws = workspace()
    await expect(
      ws.runCommand('x', {}, info(), { timeoutMs: 1000 }),
    ).rejects.toThrow('stream lost')
    expect(sandbox.commands.run).toHaveBeenCalledWith('kill -9 -- -101')
    sandbox.handle.wait.mockResolvedValue({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
    })
    expect(
      await ws.runCommand('y', {}, info(), { timeoutMs: 1000 }),
    ).toHaveProperty('result')
  })

  it('blocks when a lost command stream cannot be followed by a confirmed stop', async () => {
    const { sandbox } = mockSandbox()
    sandbox.handle.wait.mockRejectedValue(new SandboxError('stream lost'))
    sandbox.commands.run.mockImplementation(async (_command, opts) => {
      if (opts?.background) return sandbox.handle
      throw new TypeError('fetch failed')
    })
    const ws = workspace()
    await expect(
      ws.runCommand('x', {}, info(), { timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(WorkspaceBlockedError)
    await expect(ws.run(async () => 1, info())).rejects.toBeInstanceOf(
      WorkspaceBlockedError,
    )
  })

  it('restarts the kernel when a code stream is lost, then reports the failure', async () => {
    const { sandbox } = mockSandbox()
    sandbox.runCode.mockRejectedValueOnce(new Error('connection reset'))
    const ws = workspace()
    expect(
      await ws.runCode('x', 'python', undefined, info(), { timeoutMs: 1000 }),
    ).toEqual({ kernelLost: 'restarted', cause: new Error('connection reset') })
    expect(sandbox.restartCodeContext).toHaveBeenCalledTimes(1)
    expect(
      await ws.runCode('y', 'python', undefined, info(), { timeoutMs: 1000 }),
    ).toHaveProperty('execution')
  })

  it('blocks when a lost code stream cannot be followed by a kernel restart', async () => {
    const { sandbox } = mockSandbox()
    sandbox.runCode.mockRejectedValueOnce(new Error('connection reset'))
    sandbox.restartCodeContext.mockRejectedValueOnce(new Error('down'))
    const ws = workspace()
    await expect(
      ws.runCode('x', 'python', undefined, info(), { timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(WorkspaceBlockedError)
    await expect(ws.run(async () => 1, info())).rejects.toBeInstanceOf(
      WorkspaceBlockedError,
    )
  })

  it('does not restart or block after a local argument error', async () => {
    const { sandbox } = mockSandbox()
    sandbox.runCode.mockRejectedValueOnce(new InvalidArgumentError('bad'))
    const ws = workspace()
    await expect(
      ws.runCode('x', 'python', undefined, info(), { timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(InvalidArgumentError)
    expect(sandbox.restartCodeContext).not.toHaveBeenCalled()
    expect(
      await ws.runCode('y', 'python', undefined, info(), { timeoutMs: 1000 }),
    ).toHaveProperty('execution')
  })

  it('reports a kernel the server no longer knows without restarting anything', async () => {
    const { sandbox } = mockSandbox()
    const ws = workspace()
    const missing = new NotFoundError('context missing')
    sandbox.runCode.mockRejectedValueOnce(missing)
    expect(
      await ws.runCode('b', 'python', undefined, info(), { timeoutMs: 1000 }),
    ).toEqual({ kernelLost: 'missing', cause: missing })
    expect(sandbox.restartCodeContext).not.toHaveBeenCalled()
    expect(
      await ws.runCode('c', 'python', undefined, info(), { timeoutMs: 1000 }),
    ).toHaveProperty('execution')
  })
  it('applies the same start rule to background commands', async () => {
    const { sandbox } = mockSandbox()
    const ws = workspace()
    sandbox.commands.run.mockRejectedValueOnce(invalidCwd())
    await expect(
      ws.startBackground('server', { cwd: '/nope' }, undefined, info()),
    ).rejects.toBeInstanceOf(InvalidArgumentError)
    expect(
      await ws.startBackground('server', {}, undefined, info()),
    ).toMatchObject({ pid: 101 })
    expect(sandbox.handle.disconnect).toHaveBeenCalledTimes(1)
    sandbox.commands.run.mockRejectedValueOnce(new TypeError('fetch failed'))
    await expect(
      ws.startBackground('server', {}, undefined, info()),
    ).rejects.toBeInstanceOf(WorkspaceBlockedError)
    await expect(ws.run(async () => 1, info())).rejects.toBeInstanceOf(
      WorkspaceBlockedError,
    )
  })
})

describe('reconnect across processes', () => {
  const other = () => new Workspace({}, 'Retry destroy.', tag)

  it('another process finds the session sandbox by metadata instead of creating one', async () => {
    const { sandbox, create, list, connect } = mockSandbox()
    const a = workspace()
    const first = info()
    await a.run(async () => 1, first)
    expect(first.created).toBe(true)
    const b = other()
    const second = info()
    expect(await b.run(async (box) => box.sandboxId, second)).toBe(
      sandbox.sandboxId,
    )
    expect(second.created).toBe(false)
    expect(create).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenCalledWith({
      query: { metadata: tag, state: ['running', 'paused'] },
    })
    expect(connect).toHaveBeenCalledWith(sandbox.sandboxId, {
      timeoutMs: 300_000,
    })
  })

  it('another process resumes a paused session sandbox', async () => {
    const { sandbox, create, registry } = mockSandbox()
    await workspace().run(async () => 1, info())
    registry.pause(sandbox.sandboxId)
    expect(await other().run(async (box) => box.sandboxId, info())).toBe(
      sandbox.sandboxId,
    )
    expect(registry.alive(sandbox.sandboxId)?.state).toBe('running')
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('never attaches to a sandbox tagged with another session', async () => {
    const { create, registry } = mockSandbox()
    const boxes = statefulSandboxes(create)
    await new Workspace({}, 'x', { adkSessionId: 'someone-else' }).run(
      async () => 1,
      info(),
    )
    const mine = info()
    await workspace().run(async () => 1, mine)
    expect(mine.created).toBe(true)
    expect(boxes).toHaveLength(2)
    expect(registry.running()).toHaveLength(2)
  })

  it('resolves a create race by keeping the oldest sandbox and killing its own', async () => {
    const { create, list, registry } = mockSandbox()
    const boxes = statefulSandboxes(create)
    const a = workspace()
    await a.run(async () => 1, info())
    // Process B listed before A's sandbox was visible, then created its own.
    list.mockImplementationOnce(() => {
      let done = false
      return {
        get hasNext() {
          return !done
        },
        nextItems: async () => {
          done = true
          return []
        },
      } as unknown as ReturnType<typeof Sandbox.list>
    })
    const b = other()
    const outcome = info()
    const used = await b.run(async (box) => box.sandboxId, outcome)
    expect(boxes).toHaveLength(2)
    expect(used).toBe(boxes[0]!.sandboxId)
    expect(outcome.created).toBe(false)
    expect(boxes[1]!.kill).toHaveBeenCalledTimes(1)
    expect(registry.running().map((e) => e.box.sandboxId)).toEqual([
      boxes[0]!.sandboxId,
    ])
  })

  it('a destroy from another process surfaces here as expiry, then a new workspace', async () => {
    const { create } = mockSandbox()
    statefulSandboxes(create)
    const a = workspace()
    await a.run(async () => 1, info())
    await other().destroy()
    await expect(a.run(async () => 1, info())).rejects.toBeInstanceOf(
      WorkspaceExpiredError,
    )
    const fresh = info()
    await a.run(async () => 1, fresh)
    expect(fresh.created).toBe(true)
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('destroy kills session sandboxes this process never held', async () => {
    const { create, kill, registry } = mockSandbox()
    const boxes = statefulSandboxes(create)
    await workspace().run(async () => 1, info())
    const b = other()
    expect(b.idle).toBe(true)
    await b.destroy()
    expect(kill).toHaveBeenCalledWith(boxes[0]!.sandboxId)
    expect(registry.running()).toHaveLength(0)
    expect(b.idle).toBe(true)
  })

  it('a failed sweep kill blocks the workspace until a retry succeeds', async () => {
    const { create, kill, registry } = mockSandbox()
    statefulSandboxes(create)
    await workspace().run(async () => 1, info())
    kill.mockRejectedValueOnce(new Error('down'))
    const b = other()
    await expect(b.destroy()).rejects.toThrow('Sandbox cleanup failed')
    await expect(b.run(async () => 1, info())).rejects.toThrow('Retry destroy.')
    await b.destroy()
    expect(registry.running()).toHaveLength(0)
    expect(await b.run(async () => 2, info())).toBe(2)
  })

  it('reports a sandbox that vanished mid-operation as expired, not blocked', async () => {
    vi.useFakeTimers()
    const { sandbox, registry } = mockSandbox()
    sandbox.handle.wait.mockReturnValueOnce(new Promise(() => {}))
    sandbox.commands.run.mockImplementation(async (_command, opts) => {
      if (opts?.background) return sandbox.handle
      // Killed elsewhere while the command ran: the kill request fails too.
      registry.kill(sandbox.sandboxId)
      throw new Error('connection lost')
    })
    const ws = workspace()
    const run = ws
      .runCommand('loop', {}, info(), { timeoutMs: 100 })
      .catch((error) => error)
    await vi.advanceTimersByTimeAsync(100)
    expect(await run).toBeInstanceOf(WorkspaceExpiredError)
    expect(ws.idle).toBe(true)
  })
})
