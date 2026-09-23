import { describe, expect, it } from 'vitest'
import { CodeExecutionLanguage as Language } from '@google/adk'
import { TimeoutError } from '@e2b/code-interpreter'
import { E2BCodeExecutor } from '../src/index.js'
import { context, execution, mockSandbox } from './helpers.js'

describe('code executor', () => {
  it.each([
    [Language.PYTHON, 'python'],
    [Language.JAVASCRIPT, 'javascript'],
    [Language.TYPESCRIPT, 'typescript'],
    [Language.SHELL, 'bash'],
  ])('maps %s to %s', async (language, expected) => {
    const { sandbox } = mockSandbox()
    const executor = new E2BCodeExecutor()
    expect(
      await executor.executeCode({
        invocationContext: context(),
        codeExecutionInput: { code: 'code', language, inputFiles: [] },
      }),
    ).toEqual({ stdout: 'hello\n\n42', stderr: '', outputFiles: [] })
    expect(sandbox.runCode).toHaveBeenCalledWith('code', {
      context: { id: `ctx-${expected}`, language: expected, cwd: '/home/user' },
      envs: undefined,
      timeoutMs: 65_000,
    })
    await executor.close()
  })

  it.each([
    Language.UNSPECIFIED,
    Language.WINDOWS_CMD,
    Language.POWERSHELL,
    '__proto__' as Language,
    'constructor' as Language,
  ])(
    'rejects unsupported %s without creating a workspace',
    async (language) => {
      const { create } = mockSandbox()
      const result = await new E2BCodeExecutor().executeCode({
        invocationContext: context(),
        codeExecutionInput: { code: 'x', language, inputFiles: [] },
      })
      expect(result.stderr).toContain('Unsupported language')
      expect(create).not.toHaveBeenCalled()
    },
  )

  it('rejects input files and nonempty args before side effects', async () => {
    const { create } = mockSandbox()
    const executor = new E2BCodeExecutor()
    for (const input of [
      { inputFiles: [{ name: 'a', content: 'x', mimeType: 'text/plain' }] },
      { inputFiles: [], args: ['--flag'] },
      { inputFiles: [], args: { flag: true } },
    ]) {
      const result = await executor.executeCode({
        invocationContext: context(),
        codeExecutionInput: { code: 'x', language: Language.PYTHON, ...input },
      })
      expect(result.stderr).toContain('inputFiles and args are not supported')
    }
    expect(create).not.toHaveBeenCalled()
    expect(executor.optimizeDataFile).toBe(false)
    expect(executor.codeBlockDelimiters).toEqual([
      ['```tool_code\n', '\n```'],
      ['```python\n', '\n```'],
    ])
  })

  it('retains one workspace and refuses a different session, including another user with the same id', async () => {
    const { create, sandbox } = mockSandbox()
    const executor = new E2BCodeExecutor()
    const input = { code: 'x', language: Language.PYTHON, inputFiles: [] }
    await executor.executeCode({
      invocationContext: context(),
      codeExecutionInput: input,
    })
    await executor.executeCode({
      invocationContext: context(),
      codeExecutionInput: { ...input, code: 'x + 1' },
    })
    expect(create).toHaveBeenCalledTimes(1)
    for (const ctx of [
      context('different'),
      context('session', 'other-user'),
    ]) {
      expect(
        (
          await executor.executeCode({
            invocationContext: ctx,
            codeExecutionInput: input,
          })
        ).stderr,
      ).toContain('another ADK session')
    }
    expect(sandbox.runCode).toHaveBeenCalledTimes(2)
    await executor.close()
    await executor.close()
    expect(sandbox.kill).toHaveBeenCalledTimes(1)
    // close() is not terminal: a later call starts a new workspace.
    await executor.executeCode({
      invocationContext: context(),
      codeExecutionInput: input,
    })
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('bounds execution and restarts the kernel after a timeout', async () => {
    const { sandbox } = mockSandbox()
    sandbox.runCode.mockRejectedValueOnce(new TimeoutError('timed out'))
    const executor = new E2BCodeExecutor({ maxOperationMs: 5000 })
    const result = await executor.executeCode({
      invocationContext: context(),
      codeExecutionInput: {
        code: 'x',
        language: Language.PYTHON,
        inputFiles: [],
      },
    })
    expect(result.stderr).toBe(
      'Execution exceeded 5000 ms. The kernel was restarted; its variables and imports were lost.',
    )
    expect(sandbox.runCode.mock.calls[0]![1]).toMatchObject({
      timeoutMs: 10_000,
    })
    expect(sandbox.restartCodeContext).toHaveBeenCalledTimes(1)
  })

  it('normalizes runtime errors and truncates all output fields', async () => {
    const { sandbox } = mockSandbox()
    sandbox.runCode.mockResolvedValue(
      execution({
        logs: { stdout: ['x'.repeat(20000)], stderr: [] },
        error: {
          name: 'ValueError',
          value: 'bad',
          traceback: 't'.repeat(20000),
        },
      }),
    )
    const executor = new E2BCodeExecutor()
    const result = await executor.executeCode({
      invocationContext: context(),
      codeExecutionInput: {
        code: 'x',
        language: Language.PYTHON,
        inputFiles: [],
      },
    })
    expect(result.stdout).toHaveLength(10000)
    expect(result.stderr).toHaveLength(10000)
    expect(result.stderr).toContain('ValueError: bad')
    await executor.close()
  })

  it('does not expose SDK request secrets on transport failures', async () => {
    const { create } = mockSandbox()
    create.mockRejectedValue(new Error('secret-api-key'))
    const result = await new E2BCodeExecutor().executeCode({
      invocationContext: context(),
      codeExecutionInput: {
        code: 'x',
        language: Language.PYTHON,
        inputFiles: [],
      },
    })
    expect(result.stderr).toContain('Sandbox operation failed')
    expect(result.stderr).not.toContain('secret-api-key')
  })
})
