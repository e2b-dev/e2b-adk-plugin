import {
  CommandExitError,
  Sandbox,
  SandboxNotFoundError,
  TimeoutError,
  type CommandHandle,
  type CommandResult,
  type Context,
  type Execution,
} from '@e2b/code-interpreter'
import type { E2BSandboxOptions, E2BToolsetOptions } from './options.js'
import {
  OperationAbortedError,
  SandboxCleanupError,
  WorkspaceBlockedError,
  WorkspaceDestroyedError,
  WorkspaceExpiredError,
} from './results.js'

/** Upper bound for cleanup and recovery calls, independent of operation limits. */
const RECOVERY_WAIT_MS = 30_000
/** Lets our own deadline fire before the SDK's, so one path handles both. */
const SDK_GRACE_MS = 5_000

export type Stop = 'timed_out' | 'aborted'
export type CodeOutcome = { execution: Execution } | { stopped: Stop }
export type CommandOutcome =
  { result: CommandResult } | { stopped: Stop; stdout: string; stderr: string }

interface Current {
  sandbox: Sandbox
  contexts: Map<string, Promise<Context>>
}

/** Set when an operation created the sandbox, so its result can say so. */
export interface RunInfo {
  created: boolean
}

interface RunOptions {
  signal?: AbortSignal
  timeoutMs: number
}

/** Validate creation options and return the per-operation execution limit. */
export function operationLimit(options: E2BToolsetOptions): number {
  const ttl = options.sandboxOptions?.timeoutMs ?? 300_000
  if (!Number.isFinite(ttl) || ttl <= 0)
    throw new Error(
      'sandboxOptions.timeoutMs must be a positive finite number.',
    )
  const max = options.maxOperationMs ?? 600_000
  if (!Number.isSafeInteger(max) || max <= 0)
    throw new Error('maxOperationMs must be a positive integer.')
  return max
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new TimeoutError('Recovery timed out')),
        ms,
      )
    }),
  ]).finally(() => clearTimeout(timer))
}

/** Wait for `previous`, unless the caller cancels first. */
function turn(previous: Promise<unknown>, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new OperationAbortedError())
    const abort = () => reject(new OperationAbortedError())
    signal?.addEventListener('abort', abort, { once: true })
    void previous.then(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    })
  })
}

/** Aborts on the caller's signal or at the deadline, whichever comes first. */
function stopper(signal: AbortSignal | undefined, timeoutMs: number) {
  let reason: Stop | undefined
  let reject!: (error: Error) => void
  const stopped = new Promise<never>((_, fail) => (reject = fail))
  stopped.catch(() => undefined)
  const stop = (why: Stop) => {
    reason ??= why
    reject(new OperationAbortedError())
  }
  const abort = () => stop('aborted')
  const timer = setTimeout(() => stop('timed_out'), timeoutMs)
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  return {
    /** Resolves with `promise`, or rejects once stopped. */
    race: <T>(promise: Promise<T>) => Promise.race([promise, stopped]),
    get reason() {
      return reason
    },
    dispose() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    },
  }
}

/**
 * One lazily created, serialized sandbox for one ADK session. An expired or
 * destroyed sandbox is never silently replaced inside a running operation.
 */
export class Workspace {
  private current?: Current
  private queue: Promise<unknown> = Promise.resolve()
  private epoch = 0
  private pending = 0
  private destroying?: Promise<void>
  private blocked?: Error
  private readonly ttl: number

  constructor(
    private readonly options: E2BSandboxOptions,
    private readonly cleanupHint: string,
  ) {
    // The cloud default is five minutes. Do not override creation defaults.
    this.ttl = options.sandboxOptions?.timeoutMs ?? 300_000
  }

  /** No sandbox, queued work or cleanup: safe to forget. */
  get idle(): boolean {
    return this.pending === 0 && !this.current && !this.destroying
  }

  run<T>(
    operation: (sandbox: Sandbox, current: Current) => Promise<T>,
    info: RunInfo,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.destroying) return Promise.reject(new WorkspaceDestroyedError())
    const epoch = this.epoch
    const previous = this.queue
    this.pending++
    const result = turn(previous, signal).then(() =>
      this.serve(operation, info, epoch, signal),
    )
    // A cancelled waiter must not let the next operation overtake the active one.
    this.queue = Promise.allSettled([previous, result])
    return result.finally(() => this.pending--)
  }

  private async serve<T>(
    operation: (sandbox: Sandbox, current: Current) => Promise<T>,
    info: RunInfo,
    epoch: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (epoch !== this.epoch) throw new WorkspaceDestroyedError()
    if (this.blocked) throw this.blocked
    if (signal?.aborted) throw new OperationAbortedError()
    let current = this.current
    if (current) {
      try {
        await current.sandbox.setTimeout(this.ttl)
      } catch (error) {
        if (epoch !== this.epoch) throw new WorkspaceDestroyedError()
        // A paused sandbox also reports 404 here; connect() resumes it.
        // Only a sandbox that cannot be resumed is gone.
        if (
          error instanceof SandboxNotFoundError &&
          !(await this.resume(current))
        ) {
          if (this.current === current) this.current = undefined
          throw new WorkspaceExpiredError()
        }
        if (epoch !== this.epoch) throw new WorkspaceDestroyedError()
      }
    } else {
      const sandbox = this.options.template
        ? await Sandbox.create(
            this.options.template,
            this.options.sandboxOptions,
          )
        : await Sandbox.create(this.options.sandboxOptions)
      if (epoch !== this.epoch) {
        // ponytail: best effort; if this kill fails, the sandbox TTL releases it.
        await withTimeout(sandbox.kill(), RECOVERY_WAIT_MS).catch(
          () => undefined,
        )
        throw new WorkspaceDestroyedError()
      }
      current = this.current = { sandbox, contexts: new Map() }
      info.created = true
    }
    const { sandbox } = current
    const refresh = () =>
      sandbox.setTimeout(this.ttl).catch(() => {
        // Best-effort maintenance must not replace an operation's result.
      })
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
      return await operation(sandbox, current)
    } catch (error) {
      if (epoch !== this.epoch) throw new WorkspaceDestroyedError()
      throw error
    } finally {
      stopped = true
      clearTimeout(timer)
      await pending
      if (epoch === this.epoch) await refresh()
    }
  }

  runCode(
    code: string,
    language: string,
    envs: Record<string, string> | undefined,
    info: RunInfo,
    { signal, timeoutMs }: RunOptions,
  ): Promise<CodeOutcome> {
    return this.run(
      async (sandbox, current) => {
        const context = await this.context(current, language)
        if (signal?.aborted) throw new OperationAbortedError()
        const stop = stopper(signal, timeoutMs)
        const execution = sandbox.runCode(code, {
          context,
          envs,
          timeoutMs: timeoutMs + SDK_GRACE_MS,
        })
        execution.catch(() => undefined)
        try {
          return { execution: await stop.race(execution) }
        } catch (error) {
          const reason =
            stop.reason ??
            (error instanceof TimeoutError ? 'timed_out' : undefined)
          if (!reason) throw error
          // A timed-out kernel stays busy; only a restart stops the code.
          try {
            await withTimeout(
              sandbox.restartCodeContext(context),
              RECOVERY_WAIT_MS,
            )
          } catch {
            const error = new WorkspaceBlockedError(
              `The ${language} kernel could not be restarted after the code was stopped. ${this.cleanupHint}`,
            )
            if (this.current === current) this.blocked = error
            throw error
          }
          // The restart closes the open stream; don't let it outlive this turn.
          await withTimeout(execution, RECOVERY_WAIT_MS).catch(() => undefined)
          return { stopped: reason }
        } finally {
          stop.dispose()
        }
      },
      info,
      signal,
    )
  }

  runCommand(
    command: string,
    options: { cwd?: string; envs?: Record<string, string> },
    info: RunInfo,
    { signal, timeoutMs }: RunOptions,
  ): Promise<CommandOutcome> {
    return this.run(
      async (sandbox) => {
        // Own process group, so stopping the command also stops its children.
        // No abort signal here: aborting the start request leaves the process running.
        const handle = await sandbox.commands.run(
          `exec setsid -w /bin/bash -c ${quote(command)}`,
          { ...options, background: true, timeoutMs: 0 },
        )
        const stop = stopper(signal, timeoutMs)
        try {
          return { result: await stop.race(handle.wait()) }
        } catch (error) {
          if (error instanceof CommandExitError && !stop.reason)
            return { result: error }
          if (!stop.reason) throw error
          await this.killGroup(sandbox, handle)
          return {
            stopped: stop.reason,
            stdout: handle.stdout,
            stderr: handle.stderr,
          }
        } finally {
          stop.dispose()
        }
      },
      info,
      signal,
    )
  }

  private async killGroup(sandbox: Sandbox, handle: CommandHandle) {
    try {
      await withTimeout(
        sandbox.commands.run(`kill -9 -- -${handle.pid}`),
        RECOVERY_WAIT_MS,
      )
    } catch {
      // The group may be gone already; still make sure the leader is.
      await withTimeout(handle.kill(), RECOVERY_WAIT_MS)
    }
    await withTimeout(
      handle.wait().catch(() => undefined),
      RECOVERY_WAIT_MS,
    )
  }

  private async resume(current: Current): Promise<boolean> {
    try {
      await current.sandbox.connect({ timeoutMs: this.ttl })
      return true
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return false
      throw error
    }
  }

  private context(current: Current, language: string): Promise<Context> {
    let context = current.contexts.get(language)
    if (!context) {
      context = current.sandbox.createCodeContext({ language })
      current.contexts.set(language, context)
      context.catch(() => current.contexts.delete(language))
    }
    return context
  }

  /** Kill the sandbox now; queued and later-started work never recreates it. */
  destroy(): Promise<void> {
    this.destroying ??= this.kill().finally(() => {
      this.destroying = undefined
    })
    return this.destroying
  }

  private async kill() {
    this.epoch++
    const current = this.current
    if (!current) return
    try {
      await withTimeout(current.sandbox.kill(), RECOVERY_WAIT_MS)
    } catch {
      // Retain the handle so a later destroy can retry; block reuse meanwhile.
      this.blocked = new SandboxCleanupError(this.cleanupHint)
      throw this.blocked
    }
    if (this.current === current) this.current = undefined
    this.blocked = undefined
  }
}
