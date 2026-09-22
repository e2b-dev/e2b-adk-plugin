import {
  BaseCodeExecutor,
  CodeExecutionLanguage,
  type CodeExecutionResult,
  type InvocationContext,
} from '@google/adk'
import type { E2BCodeExecutorOptions } from './options.js'
import { operationError, truncate } from './results.js'
import { SandboxManager } from './sandbox-manager.js'

type ExecuteParams = Parameters<BaseCodeExecutor['executeCode']>[0]

/** Stateful code execution in one E2B workspace, owned by one ADK session. */
export class E2BCodeExecutor extends BaseCodeExecutor {
  private readonly manager: SandboxManager
  private sessionKey?: string

  constructor(options: E2BCodeExecutorOptions = {}) {
    super()
    this.manager = new SandboxManager(options)
    this.stateful = true
    // ADK's response processor currently labels extracted blocks as Python.
    this.codeBlockDelimiters = [
      ['```tool_code\n', '\n```'],
      ['```python\n', '\n```'],
    ]
  }

  override async executeCode({
    invocationContext,
    codeExecutionInput: input,
  }: ExecuteParams): Promise<CodeExecutionResult> {
    const fail = (stderr: string): CodeExecutionResult => ({
      stdout: '',
      stderr,
      outputFiles: [],
    })
    if (
      input.inputFiles?.length ||
      (input.args && Object.keys(input.args).length)
    ) {
      return fail(
        'inputFiles and args are not supported. Use E2BToolset file and command tools.',
      )
    }
    const language = {
      [CodeExecutionLanguage.PYTHON]: 'python',
      [CodeExecutionLanguage.JAVASCRIPT]: 'javascript',
      [CodeExecutionLanguage.TYPESCRIPT]: 'typescript',
      [CodeExecutionLanguage.SHELL]: 'bash',
      [CodeExecutionLanguage.UNSPECIFIED]: undefined,
      [CodeExecutionLanguage.POWERSHELL]: undefined,
      [CodeExecutionLanguage.WINDOWS_CMD]: undefined,
    }[input.language]
    if (typeof language !== 'string')
      return fail(
        'Unsupported language. Use python, javascript, typescript or shell.',
      )
    if (typeof input.code !== 'string' || !input.code.trim())
      return fail('Code must be a non-empty string.')
    const key = this.keyFor(invocationContext)
    if (this.sessionKey && this.sessionKey !== key) {
      return fail(
        'This executor belongs to another ADK session. Create a separate executor for each session.',
      )
    }
    this.sessionKey = key
    try {
      return await this.manager.run(async (sandbox) => {
        const execution = await sandbox.runCode(input.code, { language })
        const text = execution.text ? `\n${execution.text}` : ''
        const error = execution.error
          ? `\n${execution.error.name}: ${execution.error.value}\n${execution.error.traceback}`
          : ''
        return {
          stdout: truncate(execution.logs.stdout.join('') + text),
          stderr: truncate(execution.logs.stderr.join('') + error),
          outputFiles: [],
        }
      })
    } catch (error) {
      return fail(operationError(error))
    }
  }

  private keyFor(context: InvocationContext): string {
    const { appName, userId, id } = context.session
    return JSON.stringify([appName, userId, id])
  }

  /** Releases the workspace. The instance remains bound to its original session. */
  async close(): Promise<void> {
    await this.manager.close()
  }
}
