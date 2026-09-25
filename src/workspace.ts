import {
  CommandExitError,
  InvalidArgumentError,
  NotFoundError,
  Sandbox,
  SandboxNotFoundError,
  TimeoutError,
  type CommandHandle,
  type CommandResult,
  type Execution,
  type SandboxInfo,
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
  | { execution: Execution }
  | { stopped: Stop; kernelRestarted: boolean }
  /** The kernel's state is gone: restarted after a lost stream, or unknown to the server. */
  | { kernelLost: 'restarted' | 'missing'; cause: unknown }
export type CommandOutcome =
  { result: CommandResult } | { stopped: Stop; stdout: string; stderr: string }

interface Current {
  sandbox: Sandbox
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

/** The server refused before creating a process (verified live for a bad cwd). */
const refusedToStart = (error: unknown) => error instanceof InvalidArgumentError

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
 * One serialized sandbox for one ADK session, found again from any process
 * by its metadata tag. An expired or destroyed sandbox is never silently
 * replaced inside a running operation.
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
    /** Metadata that identifies this session's sandbox across processes. */
    private readonly tag: Record<string, string>,
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
      // connect() resumes a paused sandbox and only ever extends its lifetime,
      // so it never shortens what another process granted.
      try {
        await current.sandbox.connect({ timeoutMs: this.ttl })
      } catch (error) {
        check()
        // Only a sandbox-level 404 is conclusive; anything else is best effort.
        if (error instanceof SandboxNotFoundError)
          throw this.gone(current, error)
      }
    } else {
      current = await this.acquire(epoch, info)
    }
    // Setup awaited the SDK: recheck before any side effect.
    check()
    if (signal?.aborted) throw new OperationAbortedError()
    const { sandbox } = current
    const refresh = () =>
      sandbox.connect({ timeoutMs: this.ttl }).then(
        () => undefined,
        () => undefined, // Best-effort maintenance must not replace an operation's result.
      )
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
      throw this.gone(current, error)
    } finally {
      stopped = true
      clearTimeout(timer)
      await pending
      if (epoch === this.epoch) await refresh()
    }
  }

  /** The session's sandboxes, oldest first, as any process would see them. */
  private async find(): Promise<SandboxInfo[]> {
    const paginator = Sandbox.list({
      query: { metadata: this.tag, state: ['running', 'paused'] },
    })
    const infos: SandboxInfo[] = []
    while (paginator.hasNext) infos.push(...(await paginator.nextItems()))
    return infos.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
  }

  /** Connect to a listed sandbox; undefined if it vanished meanwhile. */
  private async connect(info: SandboxInfo): Promise<Sandbox | undefined> {
    try {
      return await Sandbox.connect(info.sandboxId, { timeoutMs: this.ttl })
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return undefined
      throw error
    }
  }

  /** Reuse the session's existing sandbox from any process, or create one. */
  private async acquire(epoch: number, info: RunInfo): Promise<Current> {
    const [existing] = await this.find()
    const found = existing && (await this.connect(existing))
    if (epoch !== this.epoch) throw new WorkspaceDestroyedError()
    if (found) return (this.current = { sandbox: found })
    const sandbox = await this.create(epoch)
    // Two processes may have created at once; the oldest wins everywhere.
    // Until that check succeeds, our sandbox is not the session's sandbox.
    let oldest: SandboxInfo | undefined
    try {
      ;[oldest] = await this.find()
    } catch (error) {
      await this.discard(sandbox)
      throw error
    }
    if (epoch !== this.epoch) throw new WorkspaceDestroyedError()
    if (oldest && oldest.sandboxId !== sandbox.sandboxId) {
      const winner = await this.connect(oldest)
      if (epoch !== this.epoch) throw new WorkspaceDestroyedError()
      if (winner) {
        await this.discard(sandbox)
        return (this.current = { sandbox: winner })
      }
    }
    info.created = true
    return (this.current = { sandbox })
  }

  /** Give up a sandbox we created but must not use; keep it if the kill fails. */
  private async discard(sandbox: Sandbox) {
    try {
      await withTimeout(sandbox.kill(), RECOVERY_WAIT_MS)
    } catch {
      // Not confirmed dead: keep the handle so destroy() retries, block reuse.
      this.blocked = new SandboxCleanupError(this.cleanupHint)
      throw this.blocked
    }
    this.current = undefined
  }

  private async create(epoch: number): Promise<Sandbox> {
    const { metadata, ...rest } = this.options.sandboxOptions ?? {}
    const opts = { ...rest, metadata: { ...metadata, ...this.tag } }
    const creating = this.options.template
      ? Sandbox.create(this.options.template, opts)
      : Sandbox.create(opts)
    this.creating = creating.catch(() => undefined)
    let sandbox: Sandbox
    try {
      sandbox = await creating
    } finally {
      this.creating = undefined
    }
    // Destroyed meanwhile: destroy() kills this sandbox and keeps it if that fails.
    if (epoch !== this.epoch) throw new WorkspaceDestroyedError()
    this.current = { sandbox }
    return sandbox
  }

  /** A sandbox-level 404 means the workspace is gone (expired, or destroyed elsewhere). */
  private gone(current: Current, error: unknown): unknown {
    if (!(error instanceof SandboxNotFoundError)) return error
    if (this.current === current) this.current = undefined
    return new WorkspaceExpiredError()
  }

  /**
   * Block reuse until destroy() succeeds. If the sandbox itself is gone
   * (destroyed from another process, or expired), report that instead.
   */
  private async block(current: Current, message: string): Promise<Error> {
    const alive = await Sandbox.getInfo(current.sandbox.sandboxId).then(
      () => true,
      (error: unknown) => !(error instanceof SandboxNotFoundError),
    )
    if (!alive) return this.gone(current, new SandboxNotFoundError('')) as Error
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
      async (sandbox, current) => {
        // The deadline covers kernel start-up too. The sandbox keeps one
        // kernel per language, shared by every process of this session.
        const stop = stopper(signal, timeoutMs)
        const execution = sandbox.runCode(code, {
          language,
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
          if (!reason) {
            // Refused before the code ran: nothing to stop.
            if (error instanceof InvalidArgumentError) throw error
            if (error instanceof SandboxNotFoundError) throw error
            if (error instanceof NotFoundError)
              return { kernelLost: 'missing', cause: error }
            // The stream broke, not necessarily the code: stop it first.
            await this.restart(sandbox, current, language)
            return { kernelLost: 'restarted', cause: error }
          }
          // A timed-out kernel stays busy; only a restart stops the code.
          let restarted = await this.restart(sandbox, current, language)
          if (!restarted) {
            // No kernel yet, but the request is in flight and may still start
            // one. Wait for it to settle, then look again.
            if (!(await settleWithin(execution, RECOVERY_WAIT_MS)))
              throw await this.block(
                current,
                'The code could not be confirmed stopped.',
              )
            restarted = await this.restart(sandbox, current, language)
          } else {
            // The restart closes the open stream; don't let it outlive this turn.
            await withTimeout(execution, RECOVERY_WAIT_MS).catch(
              () => undefined,
            )
          }
          return { stopped: reason, kernelRestarted: restarted }
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
          const starting = this.start(
            sandbox,
            current,
            `exec setsid -w /bin/bash -c ${quote(command)}`,
            { ...options, timeoutMs: 0 },
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
              throw await this.block(
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
                if (error instanceof SandboxNotFoundError) throw error
                // The stream broke, not necessarily the command: stop it first.
                if (!(await this.stopGroup(sandbox, handle)))
                  throw await this.block(
                    current,
                    'The connection to the command was lost and it could not be confirmed stopped.',
                  )
                throw error
              }
            }
          }
          if (!(await this.stopGroup(sandbox, handle)))
            throw await this.block(
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

  startBackground(
    command: string,
    options: { cwd?: string; envs?: Record<string, string> },
    timeoutMs: number | undefined,
    info: RunInfo,
    signal?: AbortSignal,
  ) {
    return this.run(
      async (sandbox, current) => {
        // The SDK default (60 s) would kill a disconnected process too.
        const handle = await this.start(sandbox, current, command, {
          ...options,
          timeoutMs: timeoutMs ?? 0,
        })
        // Stop consuming the SDK event stream without killing the process.
        await handle.disconnect()
        return {
          pid: handle.pid,
          host: (port: number) => sandbox.getHost(port),
        }
      },
      info,
      signal,
    )
  }

  /** Start in the background; an ambiguous failure may leave it running. */
  private async start(
    sandbox: Sandbox,
    current: Current,
    command: string,
    options: { cwd?: string; envs?: Record<string, string>; timeoutMs: number },
  ): Promise<CommandHandle> {
    try {
      return await sandbox.commands.run(command, {
        ...options,
        background: true,
      })
    } catch (error) {
      if (refusedToStart(error) || error instanceof SandboxNotFoundError)
        throw error
      const name = error instanceof Error ? error.name : 'unknown error'
      throw await this.block(
        current,
        `The command start failed (${name}); it may still be running.`,
      )
    }
  }

  /** Restart the language's kernel; false if none exists yet, so nothing ran. */
  private async restart(
    sandbox: Sandbox,
    current: Current,
    language: string,
  ): Promise<boolean> {
    try {
      const contexts = await withTimeout(
        sandbox.listCodeContexts(),
        RECOVERY_WAIT_MS,
      )
      const context = contexts.find((c) => c.language === language)
      if (!context) return false
      await withTimeout(sandbox.restartCodeContext(context), RECOVERY_WAIT_MS)
      return true
    } catch (error) {
      if (error instanceof SandboxNotFoundError) throw error
      throw await this.block(
        current,
        `The ${language} kernel could not be restarted, so the code may still be running.`,
      )
    }
  }

  /** SIGKILL the command's process group; true only if it is confirmed gone. */
  private async stopGroup(sandbox: Sandbox, handle: CommandHandle) {
    try {
      await withTimeout(
        sandbox.commands.run(`kill -9 -- -${handle.pid}`),
        RECOVERY_WAIT_MS,
      )
    } catch (error) {
      if (error instanceof SandboxNotFoundError) throw error
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

  /**
   * Kill the session's sandbox, including one created by another process or
   * before a restart; queued and later-started work never recreates it.
   */
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
    if (late) this.current = { sandbox: late }
    const current = this.current
    try {
      if (current) await withTimeout(current.sandbox.kill(), RECOVERY_WAIT_MS)
      // Sandboxes of this session that this process never held.
      for (const info of await this.find())
        await withTimeout(Sandbox.kill(info.sandboxId), RECOVERY_WAIT_MS)
    } catch {
      // Retain the handle so a later destroy can retry; block reuse meanwhile.
      this.blocked = new SandboxCleanupError(this.cleanupHint)
      throw this.blocked
    }
    if (this.current === current) this.current = undefined
    this.blocked = undefined
  }
}
