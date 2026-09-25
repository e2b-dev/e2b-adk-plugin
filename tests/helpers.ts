import { vi } from 'vitest'
import {
  Context,
  InvocationContext,
  PluginManager,
  BaseLlm,
  type Event,
  type LlmRequest,
  type LlmResponse,
  type BaseLlmConnection,
} from '@google/adk'
import {
  FileNotFoundError,
  Sandbox,
  SandboxNotFoundError,
  type Execution,
} from '@e2b/code-interpreter'

export function context(
  id = 'session',
  userId = 'user',
  abortSignal?: AbortSignal,
) {
  return new InvocationContext({
    invocationId: 'invocation',
    pluginManager: new PluginManager(),
    abortSignal,
    session: {
      id,
      userId,
      appName: 'test',
      state: {},
      events: [],
      lastUpdateTime: 0,
    },
  })
}

export function toolContext(invocation = context()) {
  return new Context({ invocationContext: invocation })
}

export function execution(overrides: Partial<Execution> = {}): Execution {
  return {
    logs: { stdout: ['hello\n'], stderr: [] },
    text: '42',
    results: [],
    ...overrides,
  } as Execution
}

/** A background CommandHandle double. */
export function commandHandle(
  result = { stdout: 'ok', stderr: '', exitCode: 0 },
) {
  return {
    pid: 101,
    stdout: '',
    stderr: '',
    wait: vi.fn().mockResolvedValue(result),
    kill: vi.fn().mockResolvedValue(true),
    disconnect: vi.fn().mockResolvedValue(undefined),
  }
}

let nextId = 0

export function fakeSandbox() {
  const handle = commandHandle()
  return {
    sandboxId: `fake-sandbox-${++nextId}`,
    handle,
    runCode: vi.fn().mockResolvedValue(execution()),
    // The sandbox keeps one default kernel per language (verified live).
    listCodeContexts: vi.fn().mockImplementation(async () =>
      ['python', 'javascript', 'typescript', 'r', 'java', 'bash'].map(
        (language) => ({
          id: `ctx-${language}`,
          language,
          cwd: '/home/user',
        }),
      ),
    ),
    restartCodeContext: vi.fn().mockResolvedValue(undefined),
    commands: {
      // Background starts return the handle; foreground calls are kill commands.
      run: vi.fn(async (_command: string, opts?: { background?: boolean }) =>
        opts?.background ? handle : { stdout: '', stderr: '', exitCode: 0 },
      ),
    },
    files: {
      write: vi.fn().mockResolvedValue({ path: '/home/user/test.txt' }),
      read: vi.fn().mockResolvedValue('contents'),
      list: vi.fn().mockResolvedValue([{ name: 'test.txt', type: 'file' }]),
    },
    getHost: vi.fn().mockReturnValue('3000-fake.e2b.app'),
    connect: vi.fn(async function (this: unknown) {
      return this
    }),
    kill: vi.fn().mockResolvedValue(true),
  }
}

export type FakeSandbox = ReturnType<typeof fakeSandbox>

interface Entry {
  box: FakeSandbox
  metadata: Record<string, string>
  startedAt: Date
  state: 'running' | 'paused' | 'killed'
}

/**
 * The E2B control plane as every "process" in a test sees it: sandboxes are
 * listed by metadata, connected by id (resuming a paused one), and killed by
 * id. A second toolset or workspace over the same registry is another process.
 */
export function registry() {
  const entries = new Map<string, Entry>()
  const info = (e: Entry) => ({
    sandboxId: e.box.sandboxId,
    metadata: e.metadata,
    startedAt: e.startedAt,
    state: e.state,
  })
  const alive = (id: string) => {
    const e = entries.get(id)
    return e && e.state !== 'killed' ? e : undefined
  }
  const reg = {
    entries,
    add(box: FakeSandbox, metadata: Record<string, string>) {
      const entry: Entry = {
        box,
        metadata,
        startedAt: new Date(1_700_000_000_000 + entries.size * 1000),
        state: 'running',
      }
      entries.set(box.sandboxId, entry)
      box.kill.mockImplementation(async () => {
        const was = entry.state !== 'killed'
        entry.state = 'killed'
        return was
      })
      box.connect.mockImplementation(async () => {
        if (entry.state === 'killed') throw new SandboxNotFoundError('gone')
        entry.state = 'running'
        return box
      })
      return entry
    },
    pause(id: string) {
      alive(id)!.state = 'paused'
    },
    kill(id: string) {
      const e = alive(id)
      if (e) e.state = 'killed'
    },
    running: () => [...entries.values()].filter((e) => e.state === 'running'),
    list(query?: { metadata?: Record<string, string>; state?: string[] }) {
      const states = query?.state ?? ['running', 'paused']
      return (
        [...entries.values()]
          .filter(
            (e) =>
              states.includes(e.state) &&
              Object.entries(query?.metadata ?? {}).every(
                ([k, v]) => e.metadata[k] === v,
              ),
          )
          // Newest first, as the real API answers.
          .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
          .map(info)
      )
    },
    alive,
    info,
  }
  return reg
}

export type Registry = ReturnType<typeof registry>

export function mockSandbox() {
  const sandbox = fakeSandbox()
  const reg = registry()
  /** Configure this to change what a create returns; the registry wraps it. */
  const create = vi.fn().mockResolvedValue(sandbox as unknown as Sandbox)
  vi.spyOn(Sandbox, 'create').mockImplementation(async (...args: unknown[]) => {
    const opts = (typeof args[0] === 'string' ? args[1] : args[0]) as
      { metadata?: Record<string, string> } | undefined
    const box = (await create(...args)) as FakeSandbox
    reg.add(box, opts?.metadata ?? {})
    return box as unknown as Sandbox
  })
  const list = vi.spyOn(Sandbox, 'list').mockImplementation(((opts?: {
    query?: Parameters<Registry['list']>[0]
  }) => {
    let done = false
    return {
      get hasNext() {
        return !done
      },
      nextItems: async () => {
        done = true
        return reg.list(opts?.query)
      },
    }
  }) as unknown as typeof Sandbox.list)
  const connect = vi.spyOn(Sandbox, 'connect').mockImplementation((async (
    id: string,
  ) => {
    const e = reg.alive(id)
    if (!e) throw new SandboxNotFoundError(`${id} not found`)
    e.state = 'running'
    return e.box
  }) as unknown as typeof Sandbox.connect)
  const kill = vi.spyOn(Sandbox, 'kill').mockImplementation(async (id) => {
    const e = reg.alive(id)
    if (e) e.state = 'killed'
    return Boolean(e)
  })
  vi.spyOn(Sandbox, 'getInfo').mockImplementation((async (id: string) => {
    const e = reg.alive(id)
    if (!e) throw new SandboxNotFoundError(`${id} not found`)
    return reg.info(e)
  }) as unknown as typeof Sandbox.getInfo)
  // Tests must never contact a model or sandbox endpoint.
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('Network disabled in tests'),
  )
  return { sandbox, create, registry: reg, list, connect, kill }
}

/** Every create returns a new sandbox with its own files, lost on kill. */
export function statefulSandboxes(
  create: ReturnType<typeof mockSandbox>['create'],
) {
  const boxes: Array<FakeSandbox & { data: Map<string, string> }> = []
  create.mockImplementation(async () => {
    const box = Object.assign(fakeSandbox(), {
      data: new Map<string, string>(),
    })
    box.files.write.mockImplementation(async (path: string, value: string) => {
      box.data.set(path, value)
      return { path }
    })
    box.files.read.mockImplementation(async (path: string) => {
      if (!box.data.has(path)) throw new FileNotFoundError(`${path} missing`)
      return box.data.get(path)
    })
    boxes.push(box)
    return box as unknown as Sandbox
  })
  return boxes
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export const tick = () => new Promise((resolve) => setImmediate(resolve))

export class ScriptedModel extends BaseLlm {
  readonly requests: LlmRequest[] = []
  private index = 0
  constructor(private readonly responses: Array<LlmResponse | Error>) {
    super({ model: 'scripted' })
  }
  override async *generateContentAsync(request: LlmRequest) {
    this.requests.push({
      ...request,
      contents: structuredClone(request.contents),
    })
    const response = this.responses[this.index++]
    if (response instanceof Error) throw response
    if (!response) throw new Error('Unexpected model call')
    yield response
  }
  override async connect(): Promise<BaseLlmConnection> {
    throw new Error('Live streaming is not used')
  }
}

export type PlannedCall = { name: string; args: Record<string, unknown> }

/**
 * Deterministic under concurrency: the latest user text is a JSON list of tool
 * calls, issued one per model turn, then "done".
 */
export class PlanModel extends BaseLlm {
  constructor() {
    super({ model: 'plan' })
  }
  override async *generateContentAsync(request: LlmRequest) {
    const parts = request.contents.flatMap((c) =>
      (c.parts ?? []).map((p) => ({ role: c.role, p })),
    )
    let start = parts.length - 1
    while (!(parts[start]!.role === 'user' && parts[start]!.p.text)) start--
    const plan = JSON.parse(parts[start]!.p.text!) as PlannedCall[]
    const done = parts.slice(start).filter((x) => x.p.functionResponse).length
    const next = plan[done]
    yield next
      ? {
          content: {
            role: 'model',
            parts: [{ functionCall: { id: `call-${done}`, ...next } }],
          },
        }
      : { content: { role: 'model', parts: [{ text: 'done' }] } }
  }
  override async connect(): Promise<BaseLlmConnection> {
    throw new Error('Live streaming is not used')
  }
}

export const plan = (...calls: PlannedCall[]) => ({
  role: 'user',
  parts: [{ text: JSON.stringify(calls) }],
})

export async function drain(stream: AsyncGenerator<Event, void, unknown>) {
  const events: Event[] = []
  for await (const event of stream) events.push(event)
  return events
}

export const toolResponses = (events: Event[]) =>
  events
    .flatMap((e) => e.content?.parts ?? [])
    .filter((p) => p.functionResponse)
    .map((p) => p.functionResponse!.response as Record<string, unknown>)
