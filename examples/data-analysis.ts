import { E2BToolset } from '@e2b/adk'
import { InMemoryRunner, LlmAgent } from '@google/adk'

const dataset = `month,region,marketing_spend,revenue
2024-01,North,12000,48000
2024-02,North,15000,60000
2024-01,South,8000,24000
2024-02,South,11000,33000`

async function analyze(userId: string, csv: string): Promise<string> {
  const toolset = new E2BToolset({
    sandboxOptions: { metadata: { example: 'adk-typescript-data-analysis' } },
  })
  const agent = new LlmAgent({
    name: 'data_analyst',
    model: 'gemini-2.5-flash',
    instruction:
      'Use write_file to save the supplied CSV to /home/user/sales.csv. ' +
      'Use run_code with Python to read that file and calculate the answers. ' +
      'Check error and exit_code fields, fix failures and rerun. ' +
      'Never report a number you have not verified in the sandbox.',
    tools: [toolset],
    generateContentConfig: {
      temperature: 0,
      thinkingConfig: { thinkingBudget: 0 },
    },
  })
  const runner = new InMemoryRunner({ agent })

  let answer = ''
  try {
    for await (const event of runner.runEphemeral({
      userId,
      newMessage: {
        role: 'user',
        parts: [
          {
            text: `${csv}\nCalculate total revenue divided by total marketing spend for each region. Which region performs better?`,
          },
        ],
      },
      runConfig: { maxLlmCalls: 8 },
    })) {
      if (event.errorCode) throw new Error(`Agent failed: ${event.errorCode}`)
      for (const part of event.content?.parts ?? []) {
        if (part.text && !part.thought) answer += part.text
      }
    }
  } finally {
    // Runner closes registered toolsets; this also covers an interrupted caller.
    await toolset.close()
  }
  return answer
}

console.log(await analyze('analyst', dataset))
