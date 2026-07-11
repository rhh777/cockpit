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

function eventTimestamp(raw: Record<string, any>): string {
  const value = raw.timestamp ?? raw.ts ?? raw.createdAt ?? raw.created_at
  if (typeof value === 'string' && value) return value
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  return new Date().toISOString()
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
  const part = asRecord(o.part)
  const usage = asRecord(o.usage) ?? asRecord(o.tokenUsage) ?? asRecord(o.token_usage) ?? asRecord(part?.tokens)
  if (!usage) return null
  const inputTokens = Number(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens ?? usage.input ?? 0)
  const outputTokens = Number(
    usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens ?? usage.output ?? 0,
  )
  if (!inputTokens && !outputTokens) return null
  return { type: 'usage', inputTokens, outputTokens, ts, agent }
}

function toolName(o: Record<string, any>): string {
  const tool = asRecord(o.tool)
  const part = asRecord(o.part)
  return firstString(o.name, o.toolName, o.tool_name, o.tool, o.command, part?.tool, tool?.name, tool?.tool, tool?.id, o.function?.name, 'tool')
}

function toolInput(o: Record<string, any>): unknown {
  const tool = asRecord(o.tool)
  const part = asRecord(o.part)
  const state = asRecord(part?.state)
  return o.args ?? o.arguments ?? o.input ?? o.params ?? state?.input ?? tool?.args ?? tool?.arguments ?? tool?.input ?? o.command ?? {}
}

function toolOutput(o: Record<string, any>): string {
  const part = asRecord(o.part)
  const state = asRecord(part?.state)
  return stringifyValue(o.output ?? o.result ?? state?.output ?? o.content ?? o.error ?? o.message ?? o.data ?? '')
}

export function normalizeJsonCliEvent(raw: Record<string, any>, agent: AgentName): NormalizedEvent[] {
  const ts = eventTimestamp(raw)
  const type = eventType(raw)
  const part = asRecord(raw.part)
  const partType = String(part?.type ?? '').toLowerCase()
  const out: NormalizedEvent[] = []

  const usage = maybeUsage(raw, ts, agent)
  if (usage) out.push(usage)

  if (type.includes('tool') || type.includes('function') || raw.tool || raw.toolName || raw.tool_name || partType === 'tool') {
    const state = asRecord(part?.state)
    const id = String(raw.id ?? part?.callID ?? part?.callId ?? part?.call_id ?? raw.toolUseId ?? raw.tool_use_id ?? raw.callId ?? raw.call_id ?? part?.id ?? `${agent}_${Date.now()}`)
    const status = String(raw.status ?? state?.status ?? raw.state ?? '').toLowerCase()
    const hasResult =
      type.includes('result') ||
      type.includes('complete') ||
      type.includes('finish') ||
      status === 'completed' ||
      status === 'failed' ||
      raw.result != null ||
      raw.output != null

    if (partType === 'tool' && state?.input != null) {
      out.push({ type: 'tool_use', id, name: toolName(raw), input: toolInput(raw), ts, agent })
    }

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
    firstString(raw.delta, raw.text, part?.text, raw.message, raw.result, raw.response, raw.content) ||
    textFromContent(raw.content) ||
    textFromContent(raw.message?.content)
  const isAssistant =
    role === 'assistant' ||
    type.includes('assistant') ||
    type === 'text' ||
    partType === 'text' ||
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
      streamId: String(raw.streamId ?? raw.stream_id ?? raw.messageId ?? raw.message_id ?? raw.id ?? part?.id ?? `${agent}:stream`),
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
