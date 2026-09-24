import { describe, expect, it, vi } from 'vitest'
import {
  CommandExitError,
  FileNotFoundError,
  InvalidArgumentError,
  SandboxNotFoundError,
} from '@e2b/code-interpreter'
import { Context } from '@google/adk'
import { E2BToolset } from '../src/index.js'
import { context, execution, mockSandbox, toolContext } from './helpers.js'

async function invoke(
  toolset: E2BToolset,
  name: string,
  args: Record<string, unknown>,
  ctx = toolContext(),
) {
  const tool = (await toolset.getTools()).find((tool) => tool.name === name)!
  return tool.runAsync({ args, toolContext: ctx })
}

describe('six tools', () => {
  it('exports declarations without creating a sandbox', async () => {
    const { create } = mockSandbox()
    const tools = await new E2BToolset({ maxOperationMs: 90_000 }).getTools()
    expect(tools.map((t) => t.name)).toEqual([
      'run_code',
      'run_command',
      'write_file',
      'read_file',
      'list_files',
      'start_background_command',
    ])
    for (const t of tools) expect(t._getDeclaration()?.parameters).toBeDefined()
    expect(JSON.stringify(tools[0]!._getDeclaration())).toContain(
      '1 to 90000. Defaults to 60000',
    )
    expect(create).not.toHaveBeenCalled()
  })

  it.each(['python', 'javascript', 'typescript', 'r', 'java', 'bash'])(
    'forwards %s through its code context and preserves runtime error semantics',
    async (language) => {
      const { sandbox } = mockSandbox()
      sandbox.runCode.mockResolvedValue(
        execution({
          error: { name: 'ValueError', value: 'bad', traceback: 'trace' },
        }),
      )
      const toolset = new E2BToolset()
      const args = { code: 'code', language, timeoutMs: 1200, envs: { X: '1' } }
      const expected = {
        success: true,
        stdout: 'hello\n',
        stderr: '',
        text: '42',
        error: 'ValueError: bad\ntrace',
      }
      expect(await invoke(toolset, 'run_code', args)).toEqual({
        ...expected,
        workspace: 'new',
      })
      expect(await invoke(toolset, 'run_code', args)).toEqual(expected)
      expect(sandbox.createCodeContext).toHaveBeenCalledTimes(1)
      expect(sandbox.createCodeContext).toHaveBeenCalledWith({ language })
      expect(sandbox.runCode).toHaveBeenCalledWith('code', {
        context: { id: `ctx-${language}`, language, cwd: '/home/user' },
        timeoutMs: 6200,
        envs: { X: '1' },
      })
    },
  )

  it.each([
    ['run_code', { code: 1 }],
    ['run_code', { code: 'x', language: 'cmd' }],
    ['run_code', { code: 'x', timeoutMs: -1 }],
    ['run_code', { code: 'x', timeoutMs: 0 }],
    ['run_code', { code: 'x', timeoutMs: 600_001 }],
    ['run_code', { code: 'x', timeoutMs: 1.5 }],
    ['run_code', { code: 'x', envs: { A: 2 } }],
    ['run_command', { command: '' }],
    ['run_command', { command: 'x', timeoutMs: 0 }],
    ['run_command', { command: 'x', timeoutMs: 600_001 }],
    ['write_file', { path: 'x' }],
    ['read_file', { path: '' }],
    ['list_files', { path: 7 }],
    ['start_background_command', { command: 'x', port: 0 }],
    ['start_background_command', { command: 'x', port: 65536 }],
    ['start_background_command', { command: 'x', port: 1.5 }],
    ['start_background_command', { command: 'x', timeoutMs: 0 }],
  ])('rejects invalid %s input before SDK effects', async (name, args) => {
    const { create } = mockSandbox()
    expect(
      await invoke(
        new E2BToolset(),
        name as string,
        args as Record<string, unknown>,
      ),
    ).toMatchObject({ success: false })
    expect(create).not.toHaveBeenCalled()
  })

  it('applies a custom maxOperationMs to the schema and the default limit', async () => {
    const { sandbox, create } = mockSandbox()
    const toolset = new E2BToolset({ maxOperationMs: 1000 })
    expect(
      await invoke(toolset, 'run_command', { command: 'x', timeoutMs: 1001 }),
    ).toMatchObject({ success: false })
    expect(create).not.toHaveBeenCalled()
    await invoke(toolset, 'run_code', { code: 'x' })
    expect(sandbox.runCode.mock.calls[0]![1]).toMatchObject({ timeoutMs: 6000 })
    expect(() => new E2BToolset({ maxOperationMs: 0 })).toThrow(
      'maxOperationMs',
    )
    expect(() => new E2BToolset({ sandboxOptions: { timeoutMs: 0 } })).toThrow(
      'sandboxOptions.timeoutMs',
    )
  })

  it('uses one workspace for file operations, including empty files', async () => {
    const { create, sandbox } = mockSandbox()
    const toolset = new E2BToolset()
    expect(
      await invoke(toolset, 'write_file', { path: 'a.txt', content: '' }),
    ).toEqual({ success: true, path: 'a.txt', workspace: 'new' })
    expect(sandbox.files.write).toHaveBeenCalledWith('a.txt', '')
    expect(await invoke(toolset, 'read_file', { path: 'a.txt' })).toEqual({
      success: true,
      path: 'a.txt',
      content: 'contents',
    })
    expect(await invoke(toolset, 'list_files', {})).toEqual({
      success: true,
      entries: [{ name: 'test.txt', type: 'file' }],
      truncated: false,
    })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('runs commands in a process group and normalizes nonzero exits', async () => {
    const { sandbox } = mockSandbox()
    const toolset = new E2BToolset()
    expect(
      await invoke(toolset, 'run_command', {
        command: 'echo ok',
        cwd: '/tmp',
        envs: { X: 'y' },
        timeoutMs: 5000,
      }),
    ).toEqual({
      success: true,
      stdout: 'ok',
      stderr: '',
      exit_code: 0,
      workspace: 'new',
    })
    expect(sandbox.commands.run).toHaveBeenCalledWith(
      "exec setsid -w /bin/bash -c 'echo ok'",
      { cwd: '/tmp', envs: { X: 'y' }, background: true, timeoutMs: 0 },
    )
    sandbox.handle.wait.mockRejectedValueOnce(
      new CommandExitError({
        stdout: 'out',
        stderr: 'err',
        exitCode: 7,
        error: 'failed',
      }),
    )
    expect(await invoke(toolset, 'run_command', { command: 'exit 7' })).toEqual(
      { success: true, stdout: 'out', stderr: 'err', exit_code: 7 },
    )
  })

  it('reports stopped commands and code explicitly', async () => {
    vi.useFakeTimers()
    try {
      const { sandbox } = mockSandbox()
      const exited = deferred()
      sandbox.handle.wait.mockReturnValueOnce(exited.promise)
      sandbox.commands.run.mockImplementation(async (command, opts) => {
        if (opts?.background) return sandbox.handle
        if (command.startsWith('kill')) exited.reject(new Error('killed'))
        return { stdout: '', stderr: '', exitCode: 0 }
      })
      const toolset = new E2BToolset()
      const command = invoke(toolset, 'run_command', {
        command: 'sleep 600',
        timeoutMs: 1000,
      })
      await vi.advanceTimersByTimeAsync(1000)
      expect(await command).toEqual({
        success: false,
        error:
          'Command timed out after 1000 ms; it and its child processes were killed.',
        timed_out: true,
        stdout: '',
        stderr: '',
        workspace: 'new',
      })
      const running = deferred()
      sandbox.runCode.mockReturnValueOnce(running.promise)
      sandbox.restartCodeContext.mockImplementation(async () =>
        running.reject(new Error('closed')),
      )
      const abort = new AbortController()
      const code = invoke(
        toolset,
        'run_code',
        { code: 'while True: pass', language: 'r' },
        toolContext(context('session', 'user', abort.signal)),
      )
      await vi.advanceTimersByTimeAsync(10)
      abort.abort()
      await vi.advanceTimersByTimeAsync(10)
      expect(await code).toEqual({
        success: false,
        error:
          'Execution was cancelled. The r kernel was restarted; its variables and imports were lost.',
        aborted: true,
        kernel_restarted: true,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns safe, actionable failures without leaking SDK messages or logging arguments', async () => {
    const { sandbox } = mockSandbox()
    const log = vi.spyOn(console, 'log')
    const debug = vi.spyOn(console, 'debug')
    const warn = vi.spyOn(console, 'warn')
    sandbox.runCode.mockRejectedValue(
      new Error('secret-key raw-code private-file'),
    )
    const toolset = new E2BToolset()
    const result = await invoke(toolset, 'run_code', {
      code: 'raw-code',
      envs: { KEY: 'secret-key' },
    })
    expect(result).toMatchObject({
      success: false,
      error: 'Sandbox operation failed.',
    })
    expect(JSON.stringify(result)).not.toMatch(
      /secret-key|raw-code|private-file/,
    )
    sandbox.files.read.mockRejectedValue(
      new FileNotFoundError('/secret/path token=abc'),
    )
    const missing = await invoke(toolset, 'read_file', { path: '/x' })
    expect(missing).toEqual({
      success: false,
      error: 'Sandbox operation failed (FileNotFoundError).',
    })
    expect(log).not.toHaveBeenCalled()
    expect(debug).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('lets the model correct a refused command, but blocks after an ambiguous start', async () => {
    const { sandbox } = mockSandbox()
    const toolset = new E2BToolset()
    sandbox.commands.run.mockRejectedValueOnce(
      new InvalidArgumentError("[invalid_argument] cwd '/nope' does not exist"),
    )
    expect(
      await invoke(toolset, 'run_command', { command: 'ls', cwd: '/nope' }),
    ).toEqual({
      success: false,
      error: 'Sandbox operation failed (InvalidArgumentError).',
      workspace: 'new',
    })
    expect(
      await invoke(toolset, 'run_command', { command: 'ls', cwd: '/tmp' }),
    ).toMatchObject({ success: true })
    sandbox.commands.run.mockRejectedValueOnce(new TypeError('fetch failed'))
    expect(
      await invoke(toolset, 'run_command', { command: 'ls' }),
    ).toMatchObject({
      success: false,
      error: expect.stringContaining('may still be running'),
    })
    expect(await invoke(toolset, 'read_file', { path: '/a' })).toMatchObject({
      success: false,
      error: expect.stringContaining('destroySession()'),
    })
  })

  it('surfaces sandbox expiry once, then a new workspace', async () => {
    const { sandbox, create } = mockSandbox()
    const toolset = new E2BToolset()
    await invoke(toolset, 'write_file', { path: 'a', content: 'x' })
    sandbox.setTimeout.mockRejectedValueOnce(new SandboxNotFoundError('gone'))
    sandbox.connect.mockRejectedValueOnce(new SandboxNotFoundError('gone'))
    expect(await invoke(toolset, 'read_file', { path: 'a' })).toEqual({
      success: false,
      error: expect.stringContaining('expired or was deleted'),
      workspace_expired: true,
    })
    expect(await invoke(toolset, 'read_file', { path: 'a' })).toMatchObject({
      success: true,
      workspace: 'new',
    })
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('keys workspaces by app, user and session, never by one of them alone', async () => {
    const { create } = mockSandbox()
    const toolset = new E2BToolset()
    for (const [id, user] of [
      ['s', 'alice'],
      ['s', 'bob'],
      ['t', 'alice'],
      ['s', 'alice'],
    ] as const)
      await invoke(toolset, 'list_files', {}, toolContext(context(id, user)))
    expect(create).toHaveBeenCalledTimes(3)
  })

  it('requires an ADK invocation context', async () => {
    const { create } = mockSandbox()
    const tool = (await new E2BToolset().getTools())[2]!
    expect(
      await tool.runAsync({
        args: { path: 'a', content: 'x' },
        toolContext: {} as Context,
      }),
    ).toMatchObject({ success: false })
    expect(create).not.toHaveBeenCalled()
  })

  it('bounds code, file and directory outputs', async () => {
    const { sandbox } = mockSandbox()
    sandbox.files.read.mockResolvedValue('x'.repeat(20000))
    sandbox.files.list.mockResolvedValue(
      Array.from({ length: 150 }, () => ({ name: 'x', type: 'file' })),
    )
    const toolset = new E2BToolset()
    const read = (await invoke(toolset, 'read_file', { path: 'x' })) as {
      content: string
    }
    expect(read.content).toHaveLength(10000)
    expect(read.content).toContain('[truncated]')
    const list = (await invoke(toolset, 'list_files', {})) as {
      entries: unknown[]
      truncated: boolean
    }
    expect(list.entries).toHaveLength(100)
    expect(list.truncated).toBe(true)
  })

  it('keeps background processes alive by default, returns the PID and an unverified URL', async () => {
    const { sandbox } = mockSandbox()
    const toolset = new E2BToolset()
    expect(
      await invoke(toolset, 'start_background_command', {
        command: 'server',
        port: 3000,
      }),
    ).toEqual({
      success: true,
      pid: 101,
      preview_url: 'https://3000-fake.e2b.app',
      readiness: 'unknown',
      workspace: 'new',
    })
    expect(sandbox.handle.disconnect).toHaveBeenCalledTimes(1)
    expect(sandbox.commands.run).toHaveBeenCalledWith('server', {
      background: true,
      timeoutMs: 0,
      cwd: undefined,
      envs: undefined,
    })
    await invoke(toolset, 'start_background_command', {
      command: 'server',
      timeoutMs: 5000,
    })
    expect(sandbox.commands.run).toHaveBeenLastCalledWith(
      'server',
      expect.objectContaining({ timeoutMs: 5000 }),
    )
    sandbox.getHost.mockImplementation(() => {
      throw new Error('host')
    })
    expect(
      await invoke(toolset, 'start_background_command', {
        command: 'server',
        port: 3000,
      }),
    ).toMatchObject({ success: true, pid: 101, preview_url: null })
    expect(
      await invoke(toolset, 'start_background_command', { command: 'server' }),
    ).toEqual({ success: true, pid: 101, preview_url: null })
  })
})

function deferred() {
  let reject!: (reason: unknown) => void
  const promise = new Promise<never>((_, rej) => (reject = rej))
  promise.catch(() => undefined)
  return { promise, reject }
}
