import type { AgentName, NormalizedEvent } from '../loaders/types'

function asRecord(v: unknown): Record<string, any> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : null
}

function firstString(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === 'string' && v) return v
  }
  return ''
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      const p = asRecord(part)
      return p ? firstString(p.text, p.content, p.value, p.delta) : ''
    })
    .filter(Boolean)
    .join('')
}

function eventType(o: Record<string, any>): string {
  return String(o.type ?? o.event ?? o.kind ?? '').toLowerCase()
}

function maybeUsage(o: Record<string, any>, ts: string, agent: AgentName): NormalizedEvent | null {
  const usage = asRecord(o.usage) ?? asRecord(o.tokenUsage) ?? asRecord(o.token_usage)
  if (!usage) return null
  const inputTokens = Number(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens ?? 0)
  const outputTokens = Number(
    usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens ?? 0,
  )
  if (!inputTokens && !outputTokens) return null
  return { type: 'usage', inputTokens, outputTokens, ts, agent }
}

function toolName(o: Record<string, any>): string {
  const tool = asRecord(o.tool)
  return firstString(o.name, o.toolName, o.tool_name, o.tool, o.command, tool?.name, tool?.tool, tool?.id, o.function?.name, 'tool')
}

function toolInput(o: Record<string, any>): unknown {
  const tool = asRecord(o.tool)
  return o.args ?? o.arguments ?? o.input ?? o.params ?? tool?.args ?? tool?.arguments ?? tool?.input ?? o.command ?? {}
}

function toolOutput(o: Record<string, any>): string {
  return stringifyValue(o.output ?? o.result ?? o.content ?? o.error ?? o.message ?? o.data ?? '')
}

export function normalizeJsonCliEvent(raw: Record<string, any>, agent: AgentName): NormalizedEvent[] {
  const ts = firstString(raw.timestamp, raw.ts, raw.createdAt, raw.created_at) || new Date().toISOString()
  const type = eventType(raw)
  const out: NormalizedEvent[] = []

  const usage = maybeUsage(raw, ts, agent)
  if (usage) out.push(usage)

  if (type.includes('tool') || type.includes('function') || raw.tool || raw.toolName || raw.tool_name) {
    const id = String(raw.id ?? raw.toolUseId ?? raw.tool_use_id ?? raw.callId ?? raw.call_id ?? `${agent}_${Date.now()}`)
    const status = String(raw.status ?? raw.state ?? '').toLowerCase()
    const hasResult =
      type.includes('result') ||
      type.includes('complete') ||
      type.includes('finish') ||
      status === 'completed' ||
      status === 'failed' ||
      raw.result != null ||
      raw.output != null

    if (hasResult) {
      out.push({
        type: 'tool_result',
        toolUseId: id,
        output: toolOutput(raw),
        isError: !!raw.isError || !!raw.is_error || status === 'failed' || type.includes('error'),
        ts,
      })
    } else {
      out.push({ type: 'tool_use', id, name: toolName(raw), input: toolInput(raw), ts, agent })
    }
    return out
  }

  const role = String(raw.role ?? raw.message?.role ?? '').toLowerCase()
  const text =
    firstString(raw.delta, raw.text, raw.message, raw.result, raw.response, raw.content) ||
    textFromContent(raw.content) ||
    textFromContent(raw.message?.content)
  const isAssistant =
    role === 'assistant' ||
    type.includes('assistant') ||
    type.includes('content') ||
    type.includes('message') ||
    type.includes('delta') ||
    type === 'output'

  if (text && isAssistant) {
    out.push({
      type: 'assistant_text',
      text,
      ts,
      agent,
      streamId: String(raw.streamId ?? raw.stream_id ?? raw.messageId ?? raw.message_id ?? raw.id ?? `${agent}:stream`),
      delta: type.includes('delta') || type.includes('content') || raw.delta != null,
    })
    return out
  }

  if (text && (type.includes('thinking') || type.includes('reasoning'))) {
    out.push({ type: 'thinking', text, ts })
    return out
  }

  if (type.includes('error') || raw.error) {
    out.push({ type: 'meta', key: `${agent}_error`, value: raw.error ?? raw.message ?? raw, ts })
    return out
  }

  const meta: NormalizedEvent = { type: 'meta', key: `${agent}_${type || 'event'}`, value: raw, ts }
  if (out.length > 0) return [...out, meta]
  return [meta]
}
