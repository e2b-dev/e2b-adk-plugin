import { Sandbox } from '@e2b/code-interpreter'
import type { E2BSandboxOptions } from './options.js'
import { SandboxCleanupError } from './results.js'

/** A serialized, lazy workspace. Expired workspaces are never silently replaced. */
export class SandboxManager {
  private sandbox?: Sandbox
  private queue: Promise<unknown> = Promise.resolve()
  private readonly ttl: number
  private cleanupFailed = false

  constructor(private readonly options: E2BSandboxOptions = {}) {
    // The cloud default is five minutes. Do not override creation defaults.
    this.ttl = options.sandboxOptions?.timeoutMs ?? 300_000
    if (!Number.isFinite(this.ttl) || this.ttl <= 0) {
      throw new Error(
        'sandboxOptions.timeoutMs must be a positive finite number.',
      )
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation)
    this.queue = result.catch(() => undefined)
    return result
  }

  run<T>(operation: (sandbox: Sandbox) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      if (this.cleanupFailed) {
        throw new SandboxCleanupError()
      }
      if (!this.sandbox) {
        this.sandbox = this.options.template
          ? await Sandbox.create(
              this.options.template,
              this.options.sandboxOptions,
            )
          : await Sandbox.create(this.options.sandboxOptions)
      }
      const sandbox = this.sandbox
      const refresh = async () => {
        try {
          await sandbox.setTimeout(this.ttl)
        } catch {
          // Best-effort maintenance must not replace an operation's result.
        }
      }
      await refresh()
      let stopped = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let pending: Promise<void> = Promise.resolve()
      const schedule = () => {
        timer = setTimeout(
          () => {
            pending = refresh().then(() => {
              if (!stopped) schedule()
            })
          },
          Math.max(100, this.ttl / 2),
        )
        timer.unref()
      }
      schedule()
      try {
        return await operation(sandbox)
      } finally {
        stopped = true
        clearTimeout(timer)
        await pending
        await refresh()
      }
    })
  }

  close(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.sandbox) return
      // Retain the handle on failure so an explicit subsequent close can retry.
      this.cleanupFailed = true
      try {
        await this.sandbox.kill()
      } catch {
        throw new SandboxCleanupError()
      }
      this.sandbox = undefined
      this.cleanupFailed = false
    })
  }
}
