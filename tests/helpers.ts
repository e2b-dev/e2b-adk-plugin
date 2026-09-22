import { vi } from 'vitest'
import {
  Context,
  InvocationContext,
  PluginManager,
  BaseLlm,
  type LlmRequest,
  type LlmResponse,
  type BaseLlmConnection,
} from '@google/adk'
import { Sandbox, type Execution } from '@e2b/code-interpreter'

export function context(id = 'session', userId = 'user') {
  return new InvocationContext({
    invocationId: 'invocation',
    pluginManager: new PluginManager(),
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

export function toolContext() {
  return new Context({ invocationContext: context() })
}

export function execution(overrides: Partial<Execution> = {}): Execution {
  return {
    logs: { stdout: ['hello\n'], stderr: [] },
    text: '42',
    results: [],
    ...overrides,
  } as Execution
}

export function fakeSandbox() {
  return {
    sandboxId: 'fake-sandbox',
    runCode: vi.fn().mockResolvedValue(execution()),
    commands: {
      run: vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 }),
    },
    files: {
      write: vi.fn().mockResolvedValue({ path: '/home/user/test.txt' }),
      read: vi.fn().mockResolvedValue('contents'),
      list: vi.fn().mockResolvedValue([{ name: 'test.txt', type: 'file' }]),
    },
    getHost: vi.fn().mockReturnValue('3000-fake.e2b.app'),
    setTimeout: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(true),
  }
}

export function mockSandbox() {
  const sandbox = fakeSandbox()
  const create = vi
    .spyOn(Sandbox, 'create')
    .mockResolvedValue(sandbox as unknown as Sandbox)
  // Tests must never contact a model or sandbox endpoint.
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('Network disabled in tests'),
  )
  return { sandbox, create }
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
