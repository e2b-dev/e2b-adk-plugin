import { E2BToolset } from '@e2b/adk'
import { InMemoryRunner, LlmAgent, type Session } from '@google/adk'

const dataset = `month,region,marketing_spend,revenue
2024-01,North,12000,48000
2024-02,North,15000,60000
2024-01,South,8000,24000
2024-02,South,11000,33000`

// One toolset and agent for the whole application; each session gets its own sandbox.
const toolset = new E2BToolset({
  sandboxOptions: { metadata: { example: 'adk-typescript-data-analysis' } },
})
const rootAgent = new LlmAgent({
  name: 'data_analyst',
  model: 'gemini-2.5-flash',
  instruction:
    'Files and Python variables persist for the whole conversation. ' +
    'Use write_file to save supplied data and run_code with Python to calculate answers. ' +
    'Check error and exit_code fields, fix failures and rerun. ' +
    'If a result has workspace_expired, earlier files are gone: ask for the data again. ' +
    'Never report a number you have not verified in the sandbox.',
  tools: [toolset],
  generateContentConfig: {
    temperature: 0,
    thinkingConfig: { thinkingBudget: 0 },
  },
})
const runner = new InMemoryRunner({ agent: rootAgent })

async function ask(session: Session, text: string): Promise<string> {
  let answer = ''
  for await (const event of runner.runAsync({
    userId: session.userId,
    sessionId: session.id,
    newMessage: { role: 'user', parts: [{ text }] },
    runConfig: { maxLlmCalls: 8 },
  })) {
    if (event.errorCode) throw new Error(`Agent failed: ${event.errorCode}`)
    for (const part of event.content?.parts ?? []) {
      if (part.text && !part.thought) answer += part.text
    }
  }
  return answer
}

const session = await runner.sessionService.createSession({
  appName: runner.appName,
  userId: 'analyst',
})
try {
  console.log(
    await ask(
      session,
      `${dataset}\nSave this CSV to /home/user/sales.csv. Calculate total revenue divided by total marketing spend for each region. Which region performs better?`,
    ),
  )
  // The follow-up reuses the saved file in the same sandbox.
  console.log(
    await ask(
      session,
      'Using the same file, which month had the highest total revenue?',
    ),
  )
} finally {
  // ADK does not release session workspaces; the application does.
  await toolset.destroySession(session)
}
