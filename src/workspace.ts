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
export type CodeOutcome =
  { execution: Execution } | { stopped: Stop; kernelRestarted: boolean }
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

type Settled<T> = { value: T } | { error: unknown } | undefined

/** How `promise` settled within `ms`; undefined if it did not. */
function settleWithin<T>(promise: Promise<T>, ms: number): Promise<Settled<T>> {
  return withTimeout(
    promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    ),
    ms,
  ).catch(() => undefined)
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

type Operation<T> = (
  sandbox: Sandbox,
  current: Current,
  /** Throws if the workspace was destroyed or blocked since the operation started. */
  check: () => void,
) => Promise<T>

/**
 * One lazily created, serialized sandbox for one ADK session. An expired or
 * destroyed sandbox is never silently replaced inside a running operation.
 */
export class Workspace {
  private current?: Current
  /** An in-flight create; destroy() owns its result. */
  private creating?: Promise<Sandbox | undefined>
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
    operation: Operation<T>,
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
    operation: Operation<T>,
    info: RunInfo,
    epoch: number,
    signal?: AbortSignal,
  ): Promise<T> {
    const check = () => {
      if (epoch !== this.epoch) throw new WorkspaceDestroyedError()
      if (this.blocked) throw this.blocked
    }
    check()
    if (signal?.aborted) throw new OperationAbortedError()
    let current = this.current
    if (current) {
      try {
        await current.sandbox.setTimeout(this.ttl)
      } catch (error) {
        check()
        // A paused sandbox also reports 404 here; connect() resumes it.
        // Only a sandbox that cannot be resumed is gone.
        if (
          error instanceof SandboxNotFoundError &&
          !(await this.resume(current))
        ) {
          check()
          if (this.current === current) this.current = undefined
          throw new WorkspaceExpiredError()
        }
      }
    } else {
      current = await this.create(epoch)
      info.created = true
    }
    // Setup awaited the SDK: recheck before any side effect.
    check()
    if (signal?.aborted) throw new OperationAbortedError()
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
      const value = await operation(sandbox, current, check)
      if (epoch !== this.epoch) throw new WorkspaceDestroyedError()
      return value
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

  private async create(epoch: number): Promise<Current> {
    const creating = this.options.template
      ? Sandbox.create(this.options.template, this.options.sandboxOptions)
      : Sandbox.create(this.options.sandboxOptions)
    this.creating = creating.catch(() => undefined)
    let sandbox: Sandbox
    try {
      sandbox = await creating
    } finally {
      this.creating = undefined
    }
    // Destroyed meanwhile: destroy() kills this sandbox and keeps it if that fails.
    if (epoch !== this.epoch) throw new WorkspaceDestroyedError()
    return (this.current = { sandbox, contexts: new Map() })
  }

  /** Block reuse until destroy() succeeds, unless this sandbox is already gone. */
  private block(current: Current, message: string): Error {
    const error = new WorkspaceBlockedError(`${message} ${this.cleanupHint}`)
    if (this.current === current) this.blocked = error
    return error
  }

  runCode(
    code: string,
    language: string,
    envs: Record<string, string> | undefined,
    info: RunInfo,
    { signal, timeoutMs }: RunOptions,
  ): Promise<CodeOutcome> {
    return this.run(
      async (sandbox, current, check) => {
        // The deadline covers kernel start-up too.
        const stop = stopper(signal, timeoutMs)
        try {
          let context: Context
          try {
            context = await stop.race(this.context(current, language))
          } catch (error) {
            // Nothing ran yet; the context stays cached for the next call.
            if (stop.reason)
              return { stopped: stop.reason, kernelRestarted: false }
            throw error
          }
          check()
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
              throw this.block(
                current,
                `The ${language} kernel could not be restarted after the code was stopped.`,
              )
            }
            // The restart closes the open stream; don't let it outlive this turn.
            await withTimeout(execution, RECOVERY_WAIT_MS).catch(
              () => undefined,
            )
            return { stopped: reason, kernelRestarted: true }
          }
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
      async (sandbox, current) => {
        // The deadline covers the start request too.
        const stop = stopper(signal, timeoutMs)
        try {
          // Own process group, so stopping the command also stops its children.
          // No abort signal here: aborting the start request leaves the process running.
          const starting = sandbox.commands.run(
            `exec setsid -w /bin/bash -c ${quote(command)}`,
            { ...options, background: true, timeoutMs: 0 },
          )
          let handle: CommandHandle
          try {
            handle = await stop.race(starting)
          } catch (error) {
            if (!stop.reason) throw error
            // Stopped while starting: the process may still start, so own it.
            const late = await settleWithin(starting, RECOVERY_WAIT_MS)
            if (!late) {
              void starting.then(
                (handle) => this.stopGroup(sandbox, handle),
                () => undefined,
              )
              throw this.block(
                current,
                'The command was stopped while starting and could not be confirmed stopped.',
              )
            }
            if ('error' in late) throw late.error
            handle = late.value
          }
          if (!stop.reason) {
            try {
              return { result: await stop.race(handle.wait()) }
            } catch (error) {
              if (!stop.reason) {
                if (error instanceof CommandExitError) return { result: error }
                throw error
              }
            }
          }
          if (!(await this.stopGroup(sandbox, handle)))
            throw this.block(
              current,
              'The command could not be confirmed stopped.',
            )
          return {
            stopped: stop.reason!,
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

  /** SIGKILL the command's process group; true only if it is confirmed gone. */
  private async stopGroup(sandbox: Sandbox, handle: CommandHandle) {
    try {
      await withTimeout(
        sandbox.commands.run(`kill -9 -- -${handle.pid}`),
        RECOVERY_WAIT_MS,
      )
    } catch (error) {
      // kill reports "No such process" once the whole group has exited.
      // Any other failure leaves the group's state unknown.
      if (!(
        error instanceof CommandExitError &&
        /No such process/.test(error.stderr)
      ))
        return false
    }
    const exited = await settleWithin(handle.wait(), RECOVERY_WAIT_MS)
    return exited !== undefined
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
    // A create still in flight belongs to this destroy, even if it lands later.
    const late = await this.creating
    if (late) this.current = { sandbox: late, contexts: new Map() }
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
