import { E2BCodeExecutor } from '@e2b/adk'
import {
  CodeExecutionLanguage,
  InvocationContext,
  PluginManager,
  createSession,
} from '@google/adk'

// Direct calls: ADK 2.1.0 does not automatically execute model code blocks
// when only LlmAgent.codeExecutor is configured. Use E2BToolset for agents.
const invocationContext = new InvocationContext({
  invocationId: 'calculation',
  pluginManager: new PluginManager(),
  session: createSession({
    id: 'calculation',
    appName: 'direct_executor',
    userId: 'user',
  }),
})
const executor = new E2BCodeExecutor({
  sandboxOptions: { metadata: { example: 'adk-typescript-direct-executor' } },
})

try {
  for (const code of ['answer = 6 * 7', 'print(answer)']) {
    const result = await executor.executeCode({
      invocationContext,
      codeExecutionInput: {
        code,
        language: CodeExecutionLanguage.PYTHON,
        inputFiles: [],
      },
    })
    if (result.stderr) throw new Error(result.stderr)
    process.stdout.write(result.stdout)
  }
} finally {
  await executor.close()
}
