import {
  BaseToolset,
  FunctionTool,
  type BaseTool,
  type ToolOptions,
} from '@google/adk'
import { CommandExitError } from '@e2b/code-interpreter'
import { z } from 'zod'
import type { E2BToolsetOptions } from './options.js'
import { failure, operationError, truncate } from './results.js'
import { SandboxManager } from './sandbox-manager.js'

const path = z.string().min(1).describe('Path inside the sandbox.')
const envs = z
  .record(z.string(), z.string())
  .optional()
  .describe('Environment variables for this operation only.')
const timeoutMs = z
  .number()
  .int()
  .nonnegative()
  .optional()
  .describe(
    'Execution timeout in milliseconds. Zero disables the SDK execution timeout.',
  )
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
  timeoutMs,
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

function tool<T extends z.ZodObject>(
  name: string,
  description: string,
  parameters: T,
  execute: ToolOptions<T>['execute'],
): BaseTool {
  return new SafeFunctionTool({
    name,
    description,
    parameters,
    execute: async (input, context) => {
      try {
        return await execute(input, context)
      } catch (error) {
        return failure(operationError(error))
      }
    },
  })
}

/** Six agent-callable tools sharing a sandbox until the runner closes the toolset. */
export class E2BToolset extends BaseToolset {
  private readonly manager: SandboxManager
  private readonly tools: BaseTool[]

  constructor(options: E2BToolsetOptions = {}) {
    super([])
    this.manager = new SandboxManager(options)
    this.tools = [
      tool(
        'run_code',
        'Execute code in a stateful E2B kernel. Returns stdout, stderr, the last expression text and runtime errors. Defaults to Python.',
        z.object({
          code: z.string().min(1),
          language: z
            .enum(['python', 'javascript', 'typescript', 'r', 'java', 'bash'])
            .default('python'),
          envs,
          timeoutMs,
        }),
        (input) =>
          this.manager.run(async (sandbox) => {
            const result = await sandbox.runCode(input.code, {
              language: input.language,
              envs: input.envs,
              timeoutMs: input.timeoutMs,
            })
            return {
              success: true,
              stdout: truncate(result.logs.stdout.join('')),
              stderr: truncate(result.logs.stderr.join('')),
              text: truncate(result.text ?? ''),
              error: result.error
                ? truncate(
                    `${result.error.name}: ${result.error.value}\n${result.error.traceback}`,
                  )
                : '',
            }
          }),
      ),
      tool(
        'run_command',
        'Run a shell command and return stdout, stderr and exit_code. Each command starts a new process; cwd and envs do not persist.',
        z.object(command),
        (input) =>
          this.manager.run(async (sandbox) => {
            try {
              const result = await sandbox.commands.run(input.command, {
                cwd: input.cwd,
                envs: input.envs,
                timeoutMs: input.timeoutMs,
              })
              return {
                success: true,
                stdout: truncate(result.stdout),
                stderr: truncate(result.stderr),
                exit_code: result.exitCode,
              }
            } catch (error) {
              if (!(error instanceof CommandExitError)) throw error
              return {
                success: true,
                stdout: truncate(error.stdout),
                stderr: truncate(error.stderr),
                exit_code: error.exitCode,
              }
            }
          }),
      ),
      tool(
        'write_file',
        'Write a UTF-8 text file inside the sandbox. Creates parent directories.',
        z.object({ path, content: z.string() }),
        (input) =>
          this.manager.run(async (sandbox) => {
            await sandbox.files.write(input.path, input.content)
            return { success: true, path: input.path }
          }),
      ),
      tool(
        'read_file',
        'Read a UTF-8 text file from the sandbox. Large content is truncated.',
        z.object({ path }),
        (input) =>
          this.manager.run(async (sandbox) => ({
            success: true,
            path: input.path,
            content: truncate(await sandbox.files.read(input.path)),
          })),
      ),
      tool(
        'list_files',
        'List entries in a sandbox directory.',
        z.object({ path: path.default('.') }),
        (input) =>
          this.manager.run(async (sandbox) => {
            const entries = await sandbox.files.list(input.path)
            return {
              success: true,
              entries: entries
                .slice(0, 100)
                .map(({ name, type }) => ({ name: truncate(name), type })),
              truncated: entries.length > 100,
            }
          }),
      ),
      tool(
        'start_background_command',
        'Start a sandbox process and return its PID immediately. Optional preview URL is not checked for readiness and expires when the runner invocation ends.',
        z.object({
          ...command,
          port: z.number().int().min(1).max(65535).optional(),
        }),
        (input) =>
          this.manager.run(async (sandbox) => {
            const handle = await sandbox.commands.run(input.command, {
              cwd: input.cwd,
              envs: input.envs,
              timeoutMs: input.timeoutMs,
              background: true,
            })
            // Stop consuming the SDK event stream without killing the process.
            await handle.disconnect()
            let previewUrl: string | null = null
            if (input.port !== undefined) {
              try {
                previewUrl = `https://${sandbox.getHost(input.port)}`
              } catch {
                /* Preserve the started process PID. */
              }
            }
            return {
              success: true,
              pid: handle.pid,
              preview_url: previewUrl,
              ...(input.port === undefined ? {} : { readiness: 'unknown' }),
            }
          }),
      ),
    ]
  }

  override async getTools(): Promise<BaseTool[]> {
    return [...this.tools]
  }

  override async close(): Promise<void> {
    await this.manager.close()
  }
}
