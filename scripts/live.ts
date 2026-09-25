import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  CodeExecutionLanguage,
  Context,
  FunctionTool,
  InMemoryRunner,
  InvocationContext,
  LlmAgent,
  PluginManager,
  type Event,
} from '@google/adk'
import { Sandbox } from '@e2b/code-interpreter'
import { z } from 'zod'
import { E2BCodeExecutor, E2BToolset } from '../src/index.js'
import { OpenAIModel } from './openai-model.js'

assert(process.env.E2B_API_KEY, 'E2B_API_KEY is required')
const runId = randomUUID()
const metadata = { adkLiveRun: runId }
const options = (extra: Record<string, unknown> = {}) => ({
  sandboxOptions: { timeoutMs: 120_000, metadata, ...extra },
})
type Result = Record<string, unknown>

function invocation(id: string, userId = 'live', abortSignal?: AbortSignal) {
  return new InvocationContext({
    invocationId: randomUUID(),
    pluginManager: new PluginManager(),
    abortSignal,
    session: {
      appName: 'live',
      userId,
      id,
      state: {},
      events: [],
      lastUpdateTime: 0,
    },
  })
}

async function remaining() {
  const paginator = Sandbox.list({ query: { metadata } })
  const ids: string[] = []
  while (paginator.hasNext)
    ids.push(...(await paginator.nextItems()).map((box) => box.sandboxId))
  return ids
}

function client(toolset: E2BToolset) {
  const tools = toolset.getTools()
  const raw = async (
    name: string,
    args: Result,
    ctx: InvocationContext,
  ): Promise<Result> =>
    (await (
      await tools
    )
      .find((tool) => tool.name === name)!
      .runAsync({
        args,
        toolContext: new Context({ invocationContext: ctx }),
      })) as Result
  const call = async (name: string, args: Result, ctx: InvocationContext) => {
    const result = await raw(name, args, ctx)
    assert.equal(result.success, true, `${name}: ${JSON.stringify(result)}`)
    return result
  }
  /** Marker-file line count and matching processes, from inside the sandbox. */
  const probe = async (ctx: InvocationContext, file: string, pattern: string) =>
    String(
      (
        await call(
          'run_command',
          {
            command: `wc -l < ${file} 2>/dev/null || echo 0; pgrep -fc '${pattern}' || true`,
          },
          ctx,
        )
      ).stdout,
    )
      .trim()
      .split('\n')
      .map(Number)
  /** Assert that writes to `file` stopped and no process matches `pattern`. */
  const stopped = async (
    ctx: InvocationContext,
    file: string,
    pattern: string,
  ) => {
    const [before] = await probe(ctx, file, pattern)
    await sleep(2000)
    const [after, processes] = await probe(ctx, file, pattern)
    assert.equal(after, before, `${file} still growing`)
    // pgrep -f also matches the probing shell itself.
    assert(processes! <= 1, `${processes} processes match ${pattern}`)
  }
  return { raw, call, stopped }
}

async function directTools() {
  const toolset = new E2BToolset(options())
  const { call } = client(toolset)
  const ctx = invocation(runId)
  const first = await call(
    'write_file',
    { path: '/home/user/adk-smoke.txt', content: 'smoke-content' },
    ctx,
  )
  assert.equal(first.workspace, 'new')
  assert.equal(
    (await call('read_file', { path: '/home/user/adk-smoke.txt' }, ctx))
      .content,
    'smoke-content',
  )
  assert.match(
    JSON.stringify(await call('list_files', { path: '/home/user' }, ctx)),
    /adk-smoke.txt/,
  )
  const exit = await call(
    'run_command',
    { command: "printf 'shell ok'; echo err >&2; exit 7", cwd: '/tmp' },
    ctx,
  )
  assert.deepEqual(
    [exit.stdout, exit.stderr, exit.exit_code],
    ['shell ok', 'err\n', 7],
  )
  // A start the sandbox refuses is an ordinary, correctable error.
  for (const name of ['run_command', 'start_background_command']) {
    const refused = await client(toolset).raw(
      name,
      { command: 'pwd', cwd: '/does/not/exist' },
      ctx,
    )
    assert.equal(
      refused.error,
      'Sandbox operation failed (InvalidArgumentError).',
      JSON.stringify(refused),
    )
  }
  assert.equal(
    (await call('run_command', { command: 'pwd', cwd: '/tmp' }, ctx)).stdout,
    '/tmp\n',
  )
  console.log('PASS a refused start (missing cwd) does not block the workspace')
  const samples: Record<string, [string, string]> = {
    python: ['v = 6 * 7', 'print(v)'],
    javascript: ['var v = 6 * 7', 'console.log(v)'],
    typescript: ['var v: number = 6 * 7', 'console.log(v)'],
    r: ['v <- 6 * 7', 'cat(v)'],
    java: ['int v = 6 * 7;', 'System.out.println(v);'],
    bash: ['v=$((6 * 7))', 'echo $v'],
  }
  for (const [language, [set, get]] of Object.entries(samples)) {
    await call('run_code', { code: set, language, timeoutMs: 30_000 }, ctx)
    const result = await call('run_code', { code: get, language }, ctx)
    assert.equal(result.error, '', `${language} execution error`)
    assert.match(`${result.stdout}${result.text}`, /42/)
    console.log(`PASS run_code ${language} keeps kernel state`)
  }
  const runtimeError = await call(
    'run_code',
    { code: 'raise ValueError("expected")' },
    ctx,
  )
  assert.match(String(runtimeError.error), /ValueError/)
  const bg = await call(
    'start_background_command',
    { command: 'python3 -m http.server 3000', port: 3000 },
    ctx,
  )
  assert.equal(typeof bg.pid, 'number')
  assert.match(String(bg.preview_url), /^https:\/\//)
  await sleep(2000)
  const served = await fetch(String(bg.preview_url))
  assert.equal(served.status, 200, 'preview URL serves the background process')
  console.log('PASS preview URL reaches the background server')
  assert.equal((await remaining()).length, 1)
  await toolset.destroySession(ctx.session)
  assert.deepEqual(await remaining(), [])
  console.log('PASS six tools, state, errors, background and destroySession')
}

async function stopMechanisms() {
  const toolset = new E2BToolset(options())
  const { raw, call, stopped } = client(toolset)
  const ctx = invocation(runId)
  const loop = (file: string) =>
    `(while :; do echo x >> ${file}; sleep 0.2; done) & sleep 600`

  let result = await raw(
    'run_command',
    { command: loop('/tmp/deadline'), timeoutMs: 3000 },
    ctx,
  )
  assert.equal(result.timed_out, true, JSON.stringify(result))
  await stopped(ctx, '/tmp/deadline', 'sleep 600')
  console.log('PASS command deadline kills the command and its children')

  for (const delay of [20, 1500]) {
    const abort = new AbortController()
    setTimeout(() => abort.abort(), delay)
    const started = Date.now()
    result = await raw(
      'run_command',
      { command: loop(`/tmp/abort${delay}`) },
      invocation(runId, 'live', abort.signal),
    )
    assert.equal(result.aborted, true, JSON.stringify(result))
    assert(Date.now() - started < 10_000, 'abort returns promptly')
    await stopped(ctx, `/tmp/abort${delay}`, 'sleep 600')
    console.log(`PASS command abort after ${delay} ms leaves no process`)
  }

  // The deadline covers the start request: a 1 ms limit kills the late handle.
  result = await raw(
    'run_command',
    { command: loop('/tmp/start'), timeoutMs: 1 },
    ctx,
  )
  assert.equal(result.timed_out, true, JSON.stringify(result))
  await stopped(ctx, '/tmp/start', 'sleep 600')
  console.log('PASS a deadline during command start kills the late process')

  // ...and kernel start-up: the request was already sent, so the kernel that
  // comes up is restarted before the result is reported.
  result = await raw(
    'run_code',
    { code: 'System.out.println(1);', language: 'java', timeoutMs: 1 },
    ctx,
  )
  assert.equal(result.timed_out, true, JSON.stringify(result))
  assert.equal(result.kernel_restarted, true, JSON.stringify(result))
  const afterStart = await call(
    'run_code',
    { code: 'System.out.println(2);', language: 'java' },
    ctx,
  )
  assert.match(String(afterStart.stdout), /2/)
  console.log('PASS a deadline during kernel start-up restarts the new kernel')

  const loops: Record<string, [string, string, string]> = {
    python: ['v = 1', 'while True:\n    pass', 'print(v)'],
    javascript: ['var v = 1', 'while (true) {}', 'console.log(v)'],
    typescript: ['var v: number = 1', 'while (true) {}', 'console.log(v)'],
    r: ['v <- 1', 'repeat {}', 'print(v)'],
    java: ['int v = 1;', 'while (true) {}', 'System.out.println(v);'],
    bash: ['v=1', 'while :; do :; done', 'echo "v=[$v]"'],
  }
  for (const [language, [set, spin, get]] of Object.entries(loops)) {
    await call('run_code', { code: set, language, timeoutMs: 30_000 }, ctx)
    result = await raw(
      'run_code',
      { code: spin, language, timeoutMs: 3000 },
      ctx,
    )
    assert.equal(
      result.timed_out,
      true,
      `${language}: ${JSON.stringify(result)}`,
    )
    assert.equal(result.kernel_restarted, true)
    const started = Date.now()
    const after = await call('run_code', { code: get, language }, ctx)
    assert(
      Date.now() - started < 15_000,
      `${language} kernel responds promptly`,
    )
    assert.doesNotMatch(
      `${after.stdout}${after.text}`,
      /\b1\b/,
      `${language} state was reset`,
    )
    console.log(
      `PASS ${language} deadline restarts the kernel (${Date.now() - started} ms)`,
    )
  }

  const abort = new AbortController()
  setTimeout(() => abort.abort(), 1500)
  result = await raw(
    'run_code',
    {
      code: "import subprocess\nsubprocess.Popen(['bash', '-c', 'while :; do echo x >> /tmp/child; sleep 0.2; done'])\nwhile True:\n    pass",
    },
    invocation(runId, 'live', abort.signal),
  )
  assert.equal(result.aborted, true, JSON.stringify(result))
  await stopped(ctx, '/tmp/child', 'tmp/child')
  console.log(
    'PASS code abort restarts the kernel and stops its child processes',
  )

  await toolset.destroySession(ctx.session)
  assert.deepEqual(await remaining(), [])
}

async function lifecycle() {
  // L3: a disconnected background process outlives the SDK's 60 s default.
  {
    const toolset = new E2BToolset(options())
    const { call } = client(toolset)
    const ctx = invocation(randomUUID())
    await call(
      'start_background_command',
      { command: 'while :; do echo x >> /tmp/bg; sleep 1; done' },
      ctx,
    )
    await sleep(70_000)
    const count = Number(
      (await call('run_command', { command: 'wc -l < /tmp/bg' }, ctx)).stdout,
    )
    assert(count >= 65, `background process stopped after ${count} s`)
    console.log(`PASS background process alive after 70 s (${count} lines)`)
    await toolset.destroyAll()
  }

  // L1/L2: a paused autoResume sandbox keeps files and kernel state.
  {
    const toolset = new E2BToolset(
      options({ lifecycle: { onTimeout: 'pause', autoResume: true } }),
    )
    const { raw, call } = client(toolset)
    const ctx = invocation(randomUUID())
    await call(
      'write_file',
      { path: '/home/user/keep.txt', content: 'kept' },
      ctx,
    )
    await call('run_code', { code: 'kept = 41' }, ctx)
    const [id] = await remaining()
    assert(await Sandbox.pause(id!), 'pause')
    console.log(`INFO paused ${id}: ${(await Sandbox.getInfo(id!)).state}`)
    const read = await raw('read_file', { path: '/home/user/keep.txt' }, ctx)
    console.log(
      `INFO first call on the paused sandbox: ${JSON.stringify(read)}`,
    )
    assert.equal(read.content, 'kept', 'files survive pause/resume')
    assert.equal(
      (await call('run_code', { code: 'kept + 1' }, ctx)).text,
      '42',
      'kernel survives pause/resume',
    )
    console.log('PASS pause/autoResume keeps files and kernel state')
    await Sandbox.pause(id!)
    await toolset.destroyAll()
    assert.deepEqual(await remaining(), [], 'destroyAll kills a paused sandbox')
    console.log('PASS destroyAll removes a paused sandbox')
  }

  // L5: TTL expiry is explicit, then a new workspace.
  {
    const toolset = new E2BToolset(options({ timeoutMs: 10_000 }))
    const { raw, call } = client(toolset)
    const ctx = invocation(randomUUID())
    await call('write_file', { path: '/home/user/x.txt', content: 'x' }, ctx)
    await sleep(25_000)
    const expired = await raw('read_file', { path: '/home/user/x.txt' }, ctx)
    assert.equal(expired.workspace_expired, true, JSON.stringify(expired))
    const fresh = await raw('read_file', { path: '/home/user/x.txt' }, ctx)
    assert.equal(fresh.workspace, 'new', JSON.stringify(fresh))
    assert.equal(fresh.success, false, 'the new workspace is empty')
    console.log('PASS TTL expiry reported once, then a new empty workspace')
    await toolset.destroyAll()
  }
  assert.deepEqual(await remaining(), [])
}

async function directExecutor() {
  const executor = new E2BCodeExecutor(options())
  const ctx = invocation(runId)
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

/** L6: the adk web / api_server shape, driven by Gemini as real users would. */
async function agent() {
  const toolset = new E2BToolset(options())
  let lastRequest = 0
  const deployed: string[] = []
  const deploy = new FunctionTool({
    name: 'deploy_report',
    description: 'Publish a report file. Requires human approval.',
    parameters: z.object({ path: z.string() }),
    requireConfirmation: true,
    execute: async ({ path }) => {
      deployed.push(path)
      return { published: path }
    },
  })
  const rootAgent = new LlmAgent({
    name: 'analyst',
    // LIVE_MODEL=openai uses a small OpenAI model when Gemini is rate limited.
    model:
      process.env.LIVE_MODEL === 'openai'
        ? new OpenAIModel()
        : 'gemini-2.5-flash',
    instruction:
      'You work in a sandbox that persists for the whole conversation. Always use the tools; never guess file contents. Report tool results exactly.',
    tools: [toolset, deploy],
    generateContentConfig: {
      temperature: 0,
      thinkingConfig: { thinkingBudget: 0 },
    },
    // Pace requests below free-tier rate limits; this is not a retry.
    beforeModelCallback: async () => {
      if (process.env.LIVE_MODEL === 'openai') return undefined
      const wait = lastRequest + 13_000 - Date.now()
      lastRequest = Math.max(Date.now(), lastRequest + 13_000)
      if (wait > 0) await sleep(wait)
      return undefined
    },
  })
  const runner = new InMemoryRunner({ agent: rootAgent, appName: 'live' })
  const say = async (
    userId: string,
    sessionId: string,
    text: string | Event['content'],
    abortSignal?: AbortSignal,
  ) => {
    const events: Event[] = []
    for await (const event of runner.runAsync({
      userId,
      sessionId,
      newMessage:
        typeof text === 'string' ? { role: 'user', parts: [{ text }] } : text!,
      runConfig: { maxLlmCalls: 10 },
      abortSignal,
    })) {
      if (event.errorCode)
        throw new Error(`Model error ${event.errorCode}: ${event.errorMessage}`)
      events.push(event)
    }
    const parts = events.flatMap((e) => e.content?.parts ?? [])
    return {
      parts,
      text: parts
        .filter((p) => p.text && !p.thought)
        .map((p) => p.text)
        .join(''),
      tools: parts
        .filter((p) => p.functionResponse)
        .map((p) => p.functionResponse!),
    }
  }
  const users = await Promise.all(
    ['alice', 'bob'].map((userId) =>
      runner.sessionService.createSession({ appName: 'live', userId }),
    ),
  )

  const firstTurn = await Promise.all(
    users.map((s) =>
      say(
        s.userId,
        s.id,
        `Write the text "${s.userId}-secret-${runId.slice(0, 6)}" to /home/user/note.txt, and store the number ${s.userId.length * 7} in a Python variable named n.`,
      ),
    ),
  )
  for (const turn of firstTurn)
    assert(
      turn.tools.some((t) => t.name === 'write_file' && t.response?.success),
    )
  assert.equal((await remaining()).length, 2, 'one sandbox per session')
  console.log('PASS two concurrent users got separate workspaces')

  for (const s of users) {
    const turn = await say(
      s.userId,
      s.id,
      'Read /home/user/note.txt and print the Python variable n. Reply with both values.',
    )
    const other = s.userId === 'alice' ? 'bob' : 'alice'
    assert.match(turn.text, new RegExp(`${s.userId}-secret`))
    assert.doesNotMatch(turn.text, new RegExp(`${other}-secret`))
    assert.match(turn.text, new RegExp(String(s.userId.length * 7)))
    console.log(
      `PASS ${s.userId}: files and kernel persisted into the next message`,
    )
  }

  const alice = users[0]!
  const paused = await say(
    alice.userId,
    alice.id,
    'Write "quarterly: 42" to /home/user/report.txt, then publish it with deploy_report, then read it back and tell me its content.',
  )
  const request = paused.parts.find(
    (p) => p.functionCall?.name === 'adk_request_confirmation',
  )?.functionCall
  assert(request, 'deploy_report asked for confirmation')
  const resumed = await say(alice.userId, alice.id, {
    role: 'user',
    parts: [
      {
        functionResponse: {
          id: request.id,
          name: request.name,
          response: { confirmed: true },
        },
      },
    ],
  })
  assert.deepEqual(deployed, ['/home/user/report.txt'])
  assert.match(resumed.text + JSON.stringify(resumed.tools), /quarterly: 42/)
  console.log('PASS workspace survived the confirmation pause')

  const bob = users[1]!
  const abort = new AbortController()
  const started = Date.now()
  const cancelled = say(
    bob.userId,
    bob.id,
    'Run exactly this shell command with run_command and timeoutMs 300000: touch /tmp/started && sleep 240',
    abort.signal,
  )
  setTimeout(() => abort.abort(), 8000)
  await cancelled
  assert(Date.now() - started < 30_000, 'cancelled run returned promptly')
  const { call } = client(toolset)
  const left = await call(
    'run_command',
    {
      command: 'test -f /tmp/started && echo started; pgrep -xc sleep || true',
    },
    invocation(bob.id, bob.userId),
  )
  assert.equal(
    String(left.stdout).trim(),
    'started\n0',
    'the command ran and no sleep process is left',
  )
  console.log('PASS runner abort stopped the command in the sandbox')

  await toolset.destroyAll()
  assert.deepEqual(await remaining(), [])
  console.log('PASS destroyAll released every session workspace')
}

const modes: Record<string, () => Promise<void>> = {
  direct: directTools,
  stop: stopMechanisms,
  executor: directExecutor,
  lifecycle,
  agent,
}
let failed = false
try {
  const selected = process.argv[2] ?? 'all'
  for (const [name, run] of Object.entries(modes))
    if (selected === 'all' || selected.split(',').includes(name)) await run()
} catch (error) {
  failed = true
  if (/429|RESOURCE_EXHAUSTED/.test(String(error)))
    console.log('INCONCLUSIVE: model rate limit (HTTP 429)')
  throw error
} finally {
  // Only clean up this run's unique metadata-tagged workspaces.
  const leaked = await remaining()
  for (const id of leaked) await Sandbox.kill(id)
  if (!failed)
    assert.equal(
      leaked.length,
      0,
      'Fallback cleanup was needed: investigate lifecycle',
    )
}
