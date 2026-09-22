import { describe, expect, it, vi } from 'vitest'
import { CommandExitError } from '@e2b/code-interpreter'
import { E2BToolset } from '../src/index.js'
import { execution, mockSandbox, toolContext } from './helpers.js'

async function invoke(
  toolset: E2BToolset,
  name: string,
  args: Record<string, unknown>,
) {
  const tool = (await toolset.getTools()).find((tool) => tool.name === name)!
  return tool.runAsync({ args, toolContext: toolContext() })
}

describe('six tools', () => {
  it('exports declarations without creating a sandbox', async () => {
    const { create } = mockSandbox()
    const tools = await new E2BToolset().getTools()
    expect(tools.map((t) => t.name)).toEqual([
      'run_code',
      'run_command',
      'write_file',
      'read_file',
      'list_files',
      'start_background_command',
    ])
    for (const t of tools) expect(t._getDeclaration()?.parameters).toBeDefined()
    expect(create).not.toHaveBeenCalled()
  })

  it.each(['python', 'javascript', 'typescript', 'r', 'java', 'bash'])(
    'forwards %s and preserves runtime error semantics',
    async (language) => {
      const { sandbox } = mockSandbox()
      sandbox.runCode.mockResolvedValue(
        execution({
          error: { name: 'ValueError', value: 'bad', traceback: 'trace' },
        }),
      )
      const toolset = new E2BToolset()
      expect(
        await invoke(toolset, 'run_code', {
          code: 'code',
          language,
          timeoutMs: 1200,
          envs: { X: '1' },
        }),
      ).toEqual({
        success: true,
        stdout: 'hello\n',
        stderr: '',
        text: '42',
        error: 'ValueError: bad\ntrace',
      })
      expect(sandbox.runCode).toHaveBeenCalledWith('code', {
        language,
        timeoutMs: 1200,
        envs: { X: '1' },
      })
      await toolset.close()
    },
  )

  it.each([
    ['run_code', { code: 1 }],
    ['run_code', { code: 'x', language: 'cmd' }],
    ['run_code', { code: 'x', timeoutMs: -1 }],
    ['run_code', { code: 'x', envs: { A: 2 } }],
    ['run_command', { command: '' }],
    ['write_file', { path: 'x' }],
    ['read_file', { path: '' }],
    ['list_files', { path: 7 }],
    ['start_background_command', { command: 'x', port: 0 }],
    ['start_background_command', { command: 'x', port: 65536 }],
    ['start_background_command', { command: 'x', port: 1.5 }],
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

  it('uses one workspace for file operations, including empty files', async () => {
    const { create, sandbox } = mockSandbox()
    const toolset = new E2BToolset()
    expect(
      await invoke(toolset, 'write_file', { path: 'a.txt', content: '' }),
    ).toEqual({ success: true, path: 'a.txt' })
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
    await toolset.close()
  })

  it('normalizes nonzero command exits as completed commands', async () => {
    const { sandbox } = mockSandbox()
    sandbox.commands.run.mockRejectedValue(
      new CommandExitError({
        stdout: 'out',
        stderr: 'err',
        exitCode: 7,
        error: 'failed',
      }),
    )
    const toolset = new E2BToolset()
    expect(
      await invoke(toolset, 'run_command', {
        command: 'exit 7',
        cwd: '/tmp',
        envs: { X: 'y' },
        timeoutMs: 0,
      }),
    ).toEqual({ success: true, stdout: 'out', stderr: 'err', exit_code: 7 })
    expect(sandbox.commands.run).toHaveBeenCalledWith('exit 7', {
      cwd: '/tmp',
      envs: { X: 'y' },
      timeoutMs: 0,
    })
    await toolset.close()
  })

  it('returns safe failures without leaking SDK messages or logging arguments', async () => {
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
    expect(result).toMatchObject({ success: false })
    expect(JSON.stringify(result)).not.toMatch(
      /secret-key|raw-code|private-file/,
    )
    expect(log).not.toHaveBeenCalled()
    expect(debug).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    await toolset.close()
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
    await toolset.close()
  })

  it('returns the background PID and an unverified URL, disconnecting the stream', async () => {
    const { sandbox } = mockSandbox()
    const disconnect = vi.fn().mockResolvedValue(undefined)
    sandbox.commands.run.mockResolvedValue({ pid: 123, disconnect })
    const toolset = new E2BToolset()
    expect(
      await invoke(toolset, 'start_background_command', {
        command: 'server',
        port: 3000,
        timeoutMs: 0,
      }),
    ).toEqual({
      success: true,
      pid: 123,
      preview_url: 'https://3000-fake.e2b.app',
      readiness: 'unknown',
    })
    expect(disconnect).toHaveBeenCalledTimes(1)
    sandbox.getHost.mockImplementation(() => {
      throw new Error('host')
    })
    expect(
      await invoke(toolset, 'start_background_command', {
        command: 'server',
        port: 3000,
      }),
    ).toMatchObject({ success: true, pid: 123, preview_url: null })
    expect(
      await invoke(toolset, 'start_background_command', { command: 'server' }),
    ).toEqual({ success: true, pid: 123, preview_url: null })
    await toolset.close()
  })
})
