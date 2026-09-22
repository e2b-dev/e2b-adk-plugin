import type { SandboxOpts } from '@e2b/code-interpreter'

/** E2B creation options. Unspecified settings retain the SDK defaults. */
export interface E2BSandboxOptions {
  template?: string
  sandboxOptions?: Omit<SandboxOpts, 'template'>
}

export type E2BCodeExecutorOptions = E2BSandboxOptions
export type E2BToolsetOptions = E2BSandboxOptions
