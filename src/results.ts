const OUTPUT_LIMIT = 10_000
const TRUNCATED = '\n[truncated]'

export function truncate(value: string): string {
  return value.length <= OUTPUT_LIMIT
    ? value
    : value.slice(0, OUTPUT_LIMIT - TRUNCATED.length) + TRUNCATED
}

export function failure(error: string) {
  return { success: false as const, error }
}

/** SDK messages may contain request bodies, environment values or credentials. */
export function operationError(error: unknown): string {
  const name = error instanceof Error ? error.name : ''
  const category = /^[A-Za-z]{1,60}(Error|Exception)$/.test(name)
    ? ` (${name})`
    : ''
  return `Sandbox operation failed${category}. Check sandbox availability and configuration.`
}
