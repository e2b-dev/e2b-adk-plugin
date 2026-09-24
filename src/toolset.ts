import {
  BaseToolset,
  FunctionTool,
  type BaseTool,
  type Session,
  type ToolOptions,
} from '@google/adk'
import { z } from 'zod'
import type { E2BToolsetOptions } from './options.js'
import {
  failure,
  kernelLost,
  OperationAbortedError,
  operationError,
  SandboxCleanupError,
  truncate,
  WorkspaceExpiredError,
} from './results.js'
import { operationLimit, Workspace, type RunInfo } from './workspace.js'

/** SDK default for code and command execution when the model sets no limit. */
const DEFAULT_TIMEOUT_MS = 60_000
const CLEANUP_HINT =
  'The application must retry destroySession() before this workspace can be used.'

type SessionRef = Pick<Session, 'appName' | 'userId' | 'id'>
type Execute<T extends z.ZodObject> = (
  input: z.infer<T>,
  workspace: Workspace,
  info: RunInfo,
  signal?: AbortSignal,
) => Promise<Record<string, unknown>>

const path = z.string().min(1).describe('Path inside the sandbox.')
const envs = z
  .record(z.string(), z.string())
  .optional()
  .describe('Environment variables for this operation only.')
const command = {
  command: z
    .string()
    .min(1)
    .describe('Shell command to execute in the sandbox.'),
  cwd: z
    .string()
    .min(1)
    .optional()
    .describe('Working directory inside the sandbox.'),
  envs,
}

/** Convert validation failures as well as execution failures into tool responses. */
class SafeFunctionTool<T extends z.ZodObject> extends FunctionTool<T> {
  override async runAsync(request: Parameters<FunctionTool['runAsync']>[0]) {
    try {
      return await super.runAsync(request)
    } catch {
      return failure(
        'Invalid tool arguments. Check the declared argument names, types and limits.',
      )
    }
  }
}

const key = ({ appName, userId, id }: SessionRef) =>
  JSON.stringify([appName, userId, id])

/**
 * Six agent-callable tools. Each ADK session gets its own lazily created
 * sandbox, kept until the application calls destroySession()/destroyAll() or
 * the sandbox timeout releases it. ADK's automatic close() leaves it running.
 */
export class E2BToolset extends BaseToolset {
  private readonly workspaces = new Map<string, Workspace>()
  private readonly tools: BaseTool[]

  constructor(private readonly options: E2BToolsetOptions = {}) {
    super([])
    const max = operationLimit(options)
    const limit = z.number().int().min(1).max(max).optional()
    const timeoutMs = limit.describe(
      `Execution limit in milliseconds, 1 to ${max}. Defaults to ${Math.min(DEFAULT_TIMEOUT_MS, max)}.`,
    )
    const deadline = (value?: number) =>
      value ?? Math.min(DEFAULT_TIMEOUT_MS, max)
    this.tools = [
      this.tool(
        'run_code',
        'Execute code in a stateful kernel, one per language, shared by the whole conversation while its workspace lives. Returns stdout, stderr, the last expression text and runtime errors. Defaults to Python.',
        z.object({
          code: z.string().min(1),
          language: z
            .enum(['python', 'javascript', 'typescript', 'r', 'java', 'bash'])
            .default('python'),
          envs,
          timeoutMs,
        }),
        async (input, workspace, info, signal) => {
          const ms = deadline(input.timeoutMs)
          const outcome = await workspace.runCode(
            input.code,
            input.language,
            input.envs,
            info,
            { signal, timeoutMs: ms },
          )
          if ('stopped' in outcome) {
            const why =
              outcome.stopped === 'timed_out'
                ? `exceeded ${ms} ms`
                : 'was cancelled'
            return outcome.kernelRestarted
              ? failure(
                  `Execution ${why}. The ${input.language} kernel was restarted; its variables and imports were lost.`,
                  { [outcome.stopped]: true, kernel_restarted: true },
                )
              : failure(
                  `Execution ${why} while the ${input.language} kernel was starting; the code did not run.`,
                  { [outcome.stopped]: true },
                )
          }
          if ('kernelLost' in outcome)
            return failure(
              kernelLost(input.language, outcome),
              outcome.kernelLost === 'restarted'
                ? { kernel_restarted: true }
                : { kernel_reset: true },
            )
          const { execution } = outcome
          return {
            success: true,
            stdout: truncate(execution.logs.stdout.join('')),
            stderr: truncate(execution.logs.stderr.join('')),
            text: truncate(execution.text ?? ''),
            error: execution.error
              ? truncate(
                  `${execution.error.name}: ${execution.error.value}\n${execution.error.traceback}`,
                )
              : '',
          }
        },
      ),
      this.tool(
        'run_command',
        'Run a shell command and return stdout, stderr and exit_code. Each command starts a new process; cwd and envs do not persist, files do.',
        z.object({ ...command, timeoutMs }),
        async (input, workspace, info, signal) => {
          const ms = deadline(input.timeoutMs)
          const outcome = await workspace.runCommand(
            input.command,
            { cwd: input.cwd, envs: input.envs },
            info,
            { signal, timeoutMs: ms },
          )
          if ('stopped' in outcome) {
            const why =
              outcome.stopped === 'timed_out'
                ? `timed out after ${ms} ms`
                : 'was cancelled'
            return failure(
              `Command ${why}; it and its child processes were killed.`,
              {
                [outcome.stopped]: true,
                stdout: truncate(outcome.stdout),
                stderr: truncate(outcome.stderr),
              },
            )
          }
          return {
            success: true,
            stdout: truncate(outcome.result.stdout),
            stderr: truncate(outcome.result.stderr),
            exit_code: outcome.result.exitCode,
          }
        },
      ),
      this.tool(
        'write_file',
        'Write a UTF-8 text file inside the sandbox. Creates parent directories.',
        z.object({ path, content: z.string() }),
        (input, workspace, info, signal) =>
          workspace.run(
            async (sandbox) => {
              await sandbox.files.write(input.path, input.content)
              return { success: true, path: input.path }
            },
            info,
            signal,
          ),
      ),
      this.tool(
        'read_file',
        'Read a UTF-8 text file from the sandbox. Large content is truncated.',
        z.object({ path }),
        (input, workspace, info, signal) =>
          workspace.run(
            async (sandbox) => ({
              success: true,
              path: input.path,
              content: truncate(await sandbox.files.read(input.path)),
            }),
            info,
            signal,
          ),
      ),
      this.tool(
        'list_files',
        'List entries in a sandbox directory.',
        z.object({ path: path.default('.') }),
        (input, workspace, info, signal) =>
          workspace.run(
            async (sandbox) => {
              const entries = await sandbox.files.list(input.path)
              return {
                success: true,
                entries: entries
                  .slice(0, 100)
                  .map(({ name, type }) => ({ name: truncate(name), type })),
                truncated: entries.length > 100,
              }
            },
            info,
            signal,
          ),
      ),
      this.tool(
        'start_background_command',
        'Start a long-running sandbox process and return its PID immediately. It runs until it exits, timeoutMs elapses, or the workspace ends. An optional preview URL is not checked for readiness.',
        z.object({
          ...command,
          timeoutMs: limit.describe(
            `Optional process lifetime in milliseconds, 1 to ${max}. Omit to keep it running.`,
          ),
          port: z.number().int().min(1).max(65535).optional(),
        }),
        async (input, workspace, info, signal) => {
          const started = await workspace.startBackground(
            input.command,
            { cwd: input.cwd, envs: input.envs },
            input.timeoutMs,
            info,
            signal,
          )
          let previewUrl: string | null = null
          if (input.port !== undefined) {
            try {
              previewUrl = `https://${started.host(input.port)}`
            } catch {
              /* Preserve the started process PID. */
            }
          }
          return {
            success: true,
            pid: started.pid,
            preview_url: previewUrl,
            ...(input.port === undefined ? {} : { readiness: 'unknown' }),
          }
        },
      ),
    ]
  }

  private workspace(session: SessionRef): Workspace {
    let workspace = this.workspaces.get(key(session))
    if (!workspace) {
      workspace = new Workspace(this.options, CLEANUP_HINT)
      this.workspaces.set(key(session), workspace)
    }
    return workspace
  }

  private tool<T extends z.ZodObject>(
    name: string,
    description: string,
    parameters: T,
    execute: Execute<T>,
  ): BaseTool {
    return new SafeFunctionTool({
      name,
      description,
      parameters,
      execute: (async (input: z.infer<T>, context) => {
        const invocation = context?.invocationContext
        if (!invocation)
          return failure('An ADK invocation context is required.')
        const info: RunInfo = { created: false }
        const result = await execute(
          input,
          this.workspace(invocation.session),
          info,
          invocation.abortSignal,
        ).catch((error: unknown) =>
          failure(operationError(error), {
            ...(error instanceof WorkspaceExpiredError && {
              workspace_expired: true,
            }),
            ...(error instanceof OperationAbortedError && { aborted: true }),
          }),
        )
        return info.created ? { ...result, workspace: 'new' } : result
      }) as ToolOptions<T>['execute'],
    })
  }

  override async getTools(): Promise<BaseTool[]> {
    return [...this.tools]
  }

  /**
   * ADK calls this after every run without saying which one ended, so it
   * releases nothing. Use destroySession() or destroyAll().
   */
  override async close(): Promise<void> {}

  /** Kill the session's sandbox. Later calls in that session start a new workspace. */
  async destroySession(session: SessionRef): Promise<void> {
    const id = key(session)
    const workspace = this.workspaces.get(id)
    if (!workspace) return
    await workspace.destroy()
    // Forget it only if no newer call has started using it meanwhile.
    if (workspace.idle && this.workspaces.get(id) === workspace)
      this.workspaces.delete(id)
  }

  /** Destroy every workspace, continuing past failures; failed ones stay retryable. */
  async destroyAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.workspaces.values()].map((workspace) => workspace.destroy()),
    )
    for (const [id, workspace] of this.workspaces)
      if (workspace.idle) this.workspaces.delete(id)
    const failed = results.filter((r) => r.status === 'rejected').length
    if (failed)
      throw new SandboxCleanupError(
        `${failed} workspace(s) could not be destroyed; retry destroyAll().`,
      )
  }
}
