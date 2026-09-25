import type { SandboxOpts } from '@e2b/code-interpreter'

/** E2B creation options. Unspecified settings retain the SDK defaults. */
export interface E2BSandboxOptions {
  template?: string
  sandboxOptions?: Omit<SandboxOpts, 'template'>
}

export interface E2BToolsetOptions extends E2BSandboxOptions {
  /** Longest a single code or command execution may run, in milliseconds. Default 600_000. */
  maxOperationMs?: number
  /**
   * Separates the sandboxes of deployments that share one E2B API key and use
   * the same ADK app name, such as staging and production. Part of the sandbox
   * metadata used to find, reuse and destroy a session's sandbox.
   */
  namespace?: string
}

export type E2BCodeExecutorOptions = E2BToolsetOptions
