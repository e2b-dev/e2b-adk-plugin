const OUTPUT_LIMIT = 10_000
const TRUNCATED = '\n[truncated]'

export class SandboxCleanupError extends Error {
  constructor(hint = '') {
    super(`Sandbox cleanup failed. ${hint}`.trim())
  }
}

/** The sandbox disappeared (TTL expiry or external kill); its state is gone. */
export class WorkspaceExpiredError extends Error {
  constructor() {
    super(
      'The sandbox for this conversation expired or was deleted; its files, kernels and processes are gone. The next call starts a new, empty workspace.',
    )
  }
}

export class WorkspaceDestroyedError extends Error {
  constructor() {
    super(
      'The application released this workspace while the operation was pending.',
    )
  }
}

export class WorkspaceBlockedError extends Error {}

export class OperationAbortedError extends Error {
  constructor() {
    super('The operation was cancelled before it started.')
  }
}

export function truncate(value: string): string {
  return value.length <= OUTPUT_LIMIT
    ? value
    : value.slice(0, OUTPUT_LIMIT - TRUNCATED.length) + TRUNCATED
}

export function failure(error: string, fields: Record<string, unknown> = {}) {
  return { success: false as const, error, ...fields }
}

/** Adapter errors carry safe text; SDK messages may contain bodies or credentials. */
export function operationError(error: unknown): string {
  if (
    error instanceof SandboxCleanupError ||
    error instanceof WorkspaceExpiredError ||
    error instanceof WorkspaceDestroyedError ||
    error instanceof WorkspaceBlockedError ||
    error instanceof OperationAbortedError
  )
    return error.message
  const name = error instanceof Error ? error.name : ''
  const category = /^[A-Za-z]{1,60}(Error|Exception)$/.test(name)
    ? ` (${name})`
    : ''
  return `Sandbox operation failed${category}.`
}
