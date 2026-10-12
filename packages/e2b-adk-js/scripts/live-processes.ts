// Two separate Node processes serve one ADK session: the second must find the
// first one's sandbox by metadata, see its files and kernel state, and a destroy
// from either side must be visible to the other.
//
//   node --env-file=.env --import tsx scripts/live-processes.ts
//
// The parent spawns itself twice as "processes" A and B, passing the session.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Context, InvocationContext, PluginManager } from '@google/adk'
import { Sandbox } from '@e2b/code-interpreter'
import { E2BToolset } from '../src/index.js'

const [role, sessionId, runId] = process.argv.slice(2)

async function tool(
  toolset: E2BToolset,
  name: string,
  args: Record<string, unknown>,
) {
  const tools = await toolset.getTools()
  const ctx = new InvocationContext({
    invocationId: randomUUID(),
    pluginManager: new PluginManager(),
    session: {
      appName: 'live-processes',
      userId: 'alice',
      id: sessionId!,
      state: {},
      events: [],
      lastUpdateTime: 0,
    },
  })
  return (await tools
    .find((t) => t.name === name)!
    .runAsync({
      args,
      toolContext: new Context({ invocationContext: ctx }),
    })) as Record<string, unknown>
}

const metadata = { adkLiveRun: runId! }
async function remaining() {
  const paginator = Sandbox.list({ query: { metadata } })
  const ids: string[] = []
  while (paginator.hasNext)
    ids.push(...(await paginator.nextItems()).map((b) => b.sandboxId))
  return ids
}

if (role === 'A') {
  // Process A: first message of the conversation.
  const toolset = new E2BToolset({
    sandboxOptions: { timeoutMs: 180_000, metadata },
  })
  const w = await tool(toolset, 'write_file', {
    path: '/home/user/from-a.txt',
    content: 'written by A',
  })
  assert.equal(w.workspace, 'new', JSON.stringify(w))
  const c = await tool(toolset, 'run_code', { code: 'from_a = 41' })
  assert.equal(c.success, true, JSON.stringify(c))
  const bg = await tool(toolset, 'start_background_command', {
    command: 'sleep 600',
  })
  assert.equal(bg.success, true)
  console.log(`A done: ${(await remaining()).join(',')}`)
} else if (role === 'B') {
  // Process B: the next message lands on another instance.
  const toolset = new E2BToolset({
    sandboxOptions: { timeoutMs: 180_000, metadata },
  })
  const r = await tool(toolset, 'read_file', { path: '/home/user/from-a.txt' })
  assert.equal(r.content, 'written by A', JSON.stringify(r))
  assert.equal(r.workspace, undefined, 'B must reuse, not create')
  const c = await tool(toolset, 'run_code', { code: 'print(from_a + 1)' })
  assert.equal(String(c.stdout).trim(), '42', JSON.stringify(c))
  const p = await tool(toolset, 'run_command', {
    command: 'pgrep -xc sleep || true',
  })
  assert.equal(
    String(p.stdout).trim(),
    '1',
    "A's background process is visible",
  )
  assert.equal((await remaining()).length, 1, 'still one sandbox')
  await toolset.destroySession({
    appName: 'live-processes',
    userId: 'alice',
    id: sessionId!,
  })
  assert.deepEqual(await remaining(), [], 'B destroyed the shared sandbox')
  console.log('B done')
} else if (role === 'A2') {
  // Process A again, after B destroyed the sandbox: its cached handle is stale.
  const toolset = new E2BToolset({
    sandboxOptions: { timeoutMs: 180_000, metadata },
  })
  // No cache in a fresh process: the next message simply starts a new workspace.
  const r = await tool(toolset, 'read_file', { path: '/home/user/from-a.txt' })
  assert.equal(r.workspace, 'new', JSON.stringify(r))
  assert.equal(r.success, false)
  await toolset.destroySession({
    appName: 'live-processes',
    userId: 'alice',
    id: sessionId!,
  })
  assert.deepEqual(await remaining(), [])
  console.log('A2 done')
} else {
  const session = randomUUID()
  const run = randomUUID()
  const step = (r: string) => {
    const out = spawnSync(
      process.execPath,
      [
        '--env-file=.env',
        '--import',
        'tsx',
        'scripts/live-processes.ts',
        r,
        session,
        run,
      ],
      { encoding: 'utf8' },
    )
    process.stdout.write(out.stdout)
    if (out.status !== 0) {
      process.stderr.write(out.stderr)
      throw new Error(`process ${r} failed`)
    }
  }
  try {
    step('A')
    step('B')
    step('A2')
    console.log('PASS two processes shared one session sandbox and cleaned up')
  } finally {
    for (const id of await remaining()) await Sandbox.kill(id)
  }
}
