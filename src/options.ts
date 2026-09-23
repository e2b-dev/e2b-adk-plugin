import type { SandboxOpts } from '@e2b/code-interpreter'

/** E2B creation options. Unspecified settings retain the SDK defaults. */
export interface E2BSandboxOptions {
  template?: string
  sandboxOptions?: Omit<SandboxOpts, 'template'>
}

export interface E2BToolsetOptions extends E2BSandboxOptions {
  /** Longest a single code or command execution may run, in milliseconds. Default 600_000. */
  maxOperationMs?: number
}

export type E2BCodeExecutorOptions = E2BToolsetOptions
