import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Sandbox } from '@e2b/code-interpreter'
import { SandboxManager } from '../src/sandbox-manager.js'
import { deferred, mockSandbox } from './helpers.js'

afterEach(() => vi.useRealTimers())

describe('workspace lifecycle', () => {
  it('is lazy and forwards only supplied SDK options', async () => {
    const { create, sandbox } = mockSandbox()
    const manager = new SandboxManager({
      template: 'custom',
      sandboxOptions: {
        timeoutMs: 1200,
        allowInternetAccess: false,
        envs: { TEST: 'value' },
      },
    })
    expect(create).not.toHaveBeenCalled()
    await manager.run(async () => 1)
    expect(create).toHaveBeenCalledWith('custom', {
      timeoutMs: 1200,
      allowInternetAccess: false,
      envs: { TEST: 'value' },
    })
    expect(sandbox.setTimeout).toHaveBeenCalledWith(1200)
    await manager.close()
  })

  it('serializes concurrent calls and closes after an in-flight create', async () => {
    const { create, sandbox } = mockSandbox()
    const pending = deferred<Sandbox>()
    create.mockReturnValue(pending.promise)
    const manager = new SandboxManager()
    const order: string[] = []
    const a = manager.run(async () => {
      order.push('a')
    })
    const b = manager.run(async () => {
      order.push('b')
    })
    const close = manager.close()
    await Promise.resolve()
    expect(create).toHaveBeenCalledTimes(1)
    expect(sandbox.kill).not.toHaveBeenCalled()
    pending.resolve(sandbox as unknown as Sandbox)
    await Promise.all([a, b, close])
    expect(order).toEqual(['a', 'b'])
    expect(sandbox.kill).toHaveBeenCalledTimes(1)
    await manager.close()
    expect(sandbox.kill).toHaveBeenCalledTimes(1)
    await manager.run(async () => undefined)
    expect(create).toHaveBeenCalledTimes(2)
    await manager.close()
  })

  it('waits for active work before killing and rejects no queued cleanup', async () => {
    const { sandbox } = mockSandbox()
    const started = deferred<void>()
    const finish = deferred<void>()
    const manager = new SandboxManager()
    const operation = manager.run(async () => {
      started.resolve()
      await finish.promise
    })
    await started.promise
    const close = manager.close()
    expect(sandbox.kill).not.toHaveBeenCalled()
    finish.resolve()
    await Promise.all([operation, close])
    expect(sandbox.kill).toHaveBeenCalledTimes(1)
  })

  it('does not silently recreate an expired sandbox or lose a failed kill handle', async () => {
    const { create, sandbox } = mockSandbox()
    const manager = new SandboxManager()
    await manager.run(async () => undefined)
    sandbox.runCode.mockRejectedValue(new Error('Expired'))
    await expect(manager.run((box) => box.runCode('1'))).rejects.toThrow(
      'Expired',
    )
    await expect(manager.run((box) => box.runCode('2'))).rejects.toThrow(
      'Expired',
    )
    expect(create).toHaveBeenCalledTimes(1)
    sandbox.kill.mockRejectedValueOnce(new Error('Unavailable'))
    await expect(manager.close()).rejects.toThrow('Unavailable')
    await manager.close()
    expect(sandbox.kill).toHaveBeenCalledTimes(2)
  })

  it('can retry a failed creation', async () => {
    const { create } = mockSandbox()
    create.mockRejectedValueOnce(new Error('Unavailable'))
    const manager = new SandboxManager()
    await expect(manager.run(async () => undefined)).rejects.toThrow(
      'Unavailable',
    )
    await manager.run(async () => undefined)
    expect(create).toHaveBeenCalledTimes(2)
    await manager.close()
  })

  it('refreshes throughout operations exceeding TTL and cancels the timer on errors', async () => {
    vi.useFakeTimers()
    const { sandbox } = mockSandbox()
    const manager = new SandboxManager({ sandboxOptions: { timeoutMs: 1000 } })
    const started = deferred<void>()
    const finish = deferred<number>()
    const work = manager.run(async () => {
      started.resolve()
      return finish.promise
    })
    await started.promise
    expect(sandbox.setTimeout).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2500)
    expect(sandbox.setTimeout).toHaveBeenCalledTimes(6)
    const rejected = expect(work).rejects.toThrow('Execution failed')
    finish.reject(new Error('Execution failed'))
    await rejected
    expect(vi.getTimerCount()).toBe(0)
    expect(sandbox.setTimeout).toHaveBeenCalledTimes(7)
    await manager.close()
  })

  it('maintenance failures do not change a successful operation', async () => {
    const { sandbox } = mockSandbox()
    sandbox.setTimeout.mockRejectedValue(new Error('Transient'))
    const manager = new SandboxManager()
    expect(await manager.run(async () => 42)).toBe(42)
    await manager.close()
  })
})
