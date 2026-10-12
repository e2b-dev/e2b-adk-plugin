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

/** The error's class name if it looks like one, never its message. */
export function errorName(error: unknown): string {
  const name = error instanceof Error ? error.name : ''
  return /^[A-Za-z]{1,60}(Error|Exception)$/.test(name) ? name : ''
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
  const name = errorName(error)
  return `Sandbox operation failed${name ? ` (${name})` : ''}.`
}

/** Tell the caller its kernel state is gone; the sandbox's files are not. */
export function kernelLost(
  language: string,
  outcome: { kernelLost: 'restarted' | 'missing'; cause: unknown },
): string {
  const name = errorName(outcome.cause)
  const cause = name ? ` (${name})` : ''
  return outcome.kernelLost === 'restarted'
    ? `The connection to the ${language} kernel was lost${cause}, so it was restarted: its variables and imports were lost. Files in the sandbox are kept.`
    : `The ${language} kernel state is no longer available${cause}; the next call starts an empty kernel. Files in the sandbox are kept.`
}
