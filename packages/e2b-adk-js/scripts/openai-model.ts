// Test-only: ADK 2.1.0 has no OpenAI provider. Used by the live harness when
// Gemini is rate limited. Not part of the published package.
import {
  BaseLlm,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk'

type Json = Record<string, unknown>

/** Gemini Schema (uppercase types, string lengths) to JSON Schema. */
function jsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(jsonSchema)
  if (!schema || typeof schema !== 'object') return schema
  const out: Json = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'type' && typeof value === 'string')
      out[key] = value.toLowerCase()
    else if (/^(min|max)(Length|Items)$/.test(key)) out[key] = Number(value)
    else out[key] = jsonSchema(value)
  }
  return out
}

export class OpenAIModel extends BaseLlm {
  constructor(model = 'gpt-4.1-mini') {
    super({ model })
  }

  override async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    const messages: Json[] = []
    const system = request.config?.systemInstruction as
      string | { parts?: { text?: string }[] } | undefined
    const instruction =
      typeof system === 'string'
        ? system
        : system?.parts?.map((p) => p.text ?? '').join('')
    if (instruction) messages.push({ role: 'system', content: instruction })
    const pending = new Set<string>()
    for (const content of request.contents) {
      const parts = content.parts ?? []
      const text = parts
        .filter((p) => p.text && !p.thought)
        .map((p) => p.text)
        .join('')
      if (content.role === 'model') {
        const calls = parts.filter((p) => p.functionCall)
        for (const p of calls) pending.add(p.functionCall!.id!)
        if (text || calls.length)
          messages.push({
            role: 'assistant',
            content: text || null,
            ...(calls.length && {
              tool_calls: calls.map((p) => ({
                id: p.functionCall!.id,
                type: 'function',
                function: {
                  name: p.functionCall!.name,
                  arguments: JSON.stringify(p.functionCall!.args ?? {}),
                },
              })),
            }),
          })
      } else {
        for (const p of parts.filter((p) => p.functionResponse)) {
          const id = p.functionResponse!.id!
          // Framework-internal responses (e.g. confirmations) have no model call.
          if (!pending.delete(id)) continue
          messages.push({
            role: 'tool',
            tool_call_id: id,
            content: JSON.stringify(p.functionResponse!.response),
          })
        }
        if (text) messages.push({ role: 'user', content: text })
      }
    }
    const tools = (request.config?.tools ?? [])
      .flatMap((t) =>
        'functionDeclarations' in t ? (t.functionDeclarations ?? []) : [],
      )
      .map((d) => ({
        type: 'function',
        function: {
          name: d.name,
          description: d.description,
          parameters: jsonSchema(
            d.parameters ??
              d.parametersJsonSchema ?? { type: 'object', properties: {} },
          ),
        },
      }))
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0,
        ...(tools.length && { tools, parallel_tool_calls: false }),
      }),
    })
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: { message?: string }
      }
      throw new Error(`OpenAI ${response.status}: ${body.error?.message ?? ''}`)
    }
    const message = (
      (await response.json()) as {
        choices: {
          message: {
            content: string | null
            tool_calls?: {
              id: string
              function: { name: string; arguments: string }
            }[]
          }
        }[]
      }
    ).choices[0]!.message
    yield {
      content: {
        role: 'model',
        parts: [
          ...(message.content ? [{ text: message.content }] : []),
          ...(message.tool_calls ?? []).map((call) => ({
            functionCall: {
              id: call.id,
              name: call.function.name,
              args: JSON.parse(call.function.arguments) as Json,
            },
          })),
        ],
      },
    }
  }

  override async connect(): Promise<BaseLlmConnection> {
    throw new Error('Live streaming is not supported by this test adapter')
  }
}
