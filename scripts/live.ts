import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  CodeExecutionLanguage,
  Context,
  InMemoryRunner,
  InvocationContext,
  LlmAgent,
  PluginManager,
} from '@google/adk'
import { Sandbox } from '@e2b/code-interpreter'
import { E2BCodeExecutor, E2BToolset } from '../src/index.js'

assert(process.env.E2B_API_KEY, 'E2B_API_KEY is required')
const runId = randomUUID()
const options = {
  sandboxOptions: { timeoutMs: 60_000, metadata: { adkLiveRun: runId } },
}
const ctx = new InvocationContext({
  invocationId: 'live',
  pluginManager: new PluginManager(),
  session: {
    appName: 'live',
    userId: 'live',
    id: runId,
    state: {},
    events: [],
    lastUpdateTime: 0,
  },
})

async function remaining() {
  const paginator = Sandbox.list({ query: { metadata: { adkLiveRun: runId } } })
  const ids: string[] = []
  while (paginator.hasNext)
    ids.push(...(await paginator.nextItems()).map((box) => box.sandboxId))
  return ids
}

async function directTools() {
  const toolset = new E2BToolset(options)
  const tools = await toolset.getTools()
  async function call(name: string, args: Record<string, unknown>) {
    const result = (await tools
      .find((tool) => tool.name === name)!
      .runAsync({
        args,
        toolContext: new Context({ invocationContext: ctx }),
      })) as Record<string, unknown>
    assert.equal(
      result.success,
      true,
      `Tool ${name} failed: ${JSON.stringify(result)}`,
    )
    return result
  }
  try {
    await call('write_file', {
      path: '/home/user/adk-smoke.txt',
      content: 'smoke-content',
    })
    assert.equal(
      (await call('read_file', { path: '/home/user/adk-smoke.txt' })).content,
      'smoke-content',
    )
    assert.match(
      JSON.stringify(await call('list_files', { path: '/home/user' })),
      /adk-smoke.txt/,
    )
    assert.equal(
      (await call('run_command', { command: 'printf shell-ok; exit 7' }))
        .exit_code,
      7,
    )
    const samples: Record<string, string> = {
      python: 'print(6 * 7)',
      javascript: 'console.log(6 * 7)',
      typescript: 'const n: number = 6 * 7; console.log(n)',
      r: 'cat(6 * 7)',
      java: 'System.out.println(6 * 7);',
      bash: 'echo $((6 * 7))',
    }
    for (const [language, code] of Object.entries(samples)) {
      const result = await call('run_code', {
        code,
        language,
        timeoutMs: 20_000,
      })
      assert.equal(result.error, '', `${language} execution error`)
      assert.match(`${result.stdout}${result.text}`, /42/)
      console.log(`PASS run_code ${language}`)
    }
    await call('run_code', { code: 'adk_value = 17' })
    assert.equal((await call('run_code', { code: 'adk_value + 1' })).text, '18')
    const runtimeError = await call('run_code', {
      code: 'raise ValueError("expected")',
    })
    assert.match(String(runtimeError.error), /ValueError/)
    const bg = await call('start_background_command', {
      command: 'sleep 30',
      port: 3000,
      timeoutMs: 0,
    })
    assert.equal(typeof bg.pid, 'number')
    assert.match(String(bg.preview_url), /^https:\/\//)
    assert.equal(bg.readiness, 'unknown')
    assert.equal((await remaining()).length, 1)
  } finally {
    await toolset.close()
  }
  assert.deepEqual(await remaining(), [])
  console.log('PASS six tools, state, errors, background and cleanup')
}

async function directExecutor() {
  const executor = new E2BCodeExecutor(options)
  try {
    for (const [language, code] of [
      [CodeExecutionLanguage.PYTHON, 'print(21 * 2)'],
      [CodeExecutionLanguage.JAVASCRIPT, 'console.log(21 * 2)'],
      [
        CodeExecutionLanguage.TYPESCRIPT,
        'const v: number = 21 * 2; console.log(v)',
      ],
      [CodeExecutionLanguage.SHELL, 'echo $((21 * 2))'],
    ] as const) {
      const result = await executor.executeCode({
        invocationContext: ctx,
        codeExecutionInput: { code, language, inputFiles: [] },
      })
      assert.equal(result.stderr, '', `${language}: ${result.stderr}`)
      assert.match(result.stdout, /42/)
      console.log(`PASS executor ${language}`)
    }
  } finally {
    await executor.close()
  }
  assert.deepEqual(await remaining(), [])
}

async function agentTools() {
  const toolset = new E2BToolset(options)
  const runner = new InMemoryRunner({
    agent: new LlmAgent({
      name: 'sandbox_smoke',
      model: 'gemini-2.5-flash',
      instruction:
        'Use write_file to save the requested file, then run_code to read it and compute. Always actually call tools. Return the computed answer.',
      tools: [toolset],
      generateContentConfig: {
        temperature: 0,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  })
  const completed: string[] = []
  let output = ''
  try {
    for await (const event of runner.runEphemeral({
      userId: 'live',
      newMessage: {
        role: 'user',
        parts: [
          {
            text: 'Save the text 6,7 into /home/user/numbers.txt. Read it using Python, multiply the two numbers and report the result.',
          },
        ],
      },
      runConfig: { maxLlmCalls: 6 },
    })) {
      assert(!event.errorCode, `Model error: ${event.errorCode}`)
      for (const part of event.content?.parts ?? []) {
        if (part.functionResponse) {
          completed.push(part.functionResponse.name ?? '')
          assert.equal(part.functionResponse.response?.success, true)
        }
        if (part.text) output += part.text
      }
    }
    assert(completed.includes('write_file'))
    assert(completed.includes('run_code'))
    assert.match(output, /42/)
    assert.deepEqual(await remaining(), [], 'Runner must close the sandbox')
  } finally {
    await toolset.close()
  }
  console.log('PASS Gemini tool routing, file analysis and runner cleanup')
}

try {
  const mode = process.argv[2] ?? 'all'
  if (mode === 'all' || mode === 'direct') {
    await directTools()
    await directExecutor()
  }
  if (mode === 'all' || mode === 'agent') await agentTools()
} finally {
  // Only clean up this run's unique metadata-tagged workspaces.
  const leaked = await remaining()
  for (const id of leaked) await Sandbox.kill(id)
  assert.equal(
    leaked.length,
    0,
    'Fallback cleanup was needed: investigate lifecycle',
  )
}
