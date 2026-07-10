import type { AgentName } from '../loaders/types'

export type SerialStatus = 'needs-review' | 'needs-changes' | 'consensus' | 'blocked'
export type SerialNext = AgentName | '@user'

export interface SerialDirective {
  ok: boolean
  next?: SerialNext
  status?: SerialStatus
  error?: string
}

const AGENTS = new Set<AgentName>(['claude', 'codex', 'opencode', 'cursor'])
const STATUS = new Set<SerialStatus>(['needs-review', 'needs-changes', 'consensus', 'blocked'])

function visibleTailLines(text: string): string[] {
  const out: string[] = []
  let inFence = false
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim()
    if (/^```/.test(trimmed) || /^~~~/.test(trimmed)) {
      inFence = !inFence
      continue
    }
    if (inFence || trimmed.startsWith('>')) continue
    out.push(raw)
  }
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
  return out
}

function directiveValue(line: string, key: 'next' | 'status'): string | undefined {
  const m = line.trim().match(new RegExp(`^${key}\\s*[:：]\\s*(.+?)\\s*$`, 'i'))
  return m?.[1]?.trim()
}

export function parseSerialDirective(text: string): SerialDirective {
  const tail = visibleTailLines(text).slice(-6)
  let nextRaw: string | undefined
  let statusRaw: string | undefined
  for (const line of tail) {
    nextRaw = directiveValue(line, 'next') ?? nextRaw
    statusRaw = directiveValue(line, 'status') ?? statusRaw
  }
  if (!nextRaw || !statusRaw) {
    const tailText = tail.join('\n')
    nextRaw = nextRaw ?? tailText.match(/(?:^|\n)\s*next\s*[:：]\s*(.+?)(?=\s+status\s*[:：]|\n|$)/i)?.[1]?.trim()
    statusRaw = statusRaw ?? tailText.match(/(?:^|\s)status\s*[:：]\s*([a-z-]+)\s*$/i)?.[1]?.trim()
  }
  if (!nextRaw || !statusRaw) return { ok: false, error: 'protocol-missing' }

  const status = statusRaw.toLowerCase() as SerialStatus
  if (!STATUS.has(status)) return { ok: false, error: 'invalid-status' }

  const mentions = [...nextRaw.matchAll(/@(claude|codex|opencode|cursor|user)\b/gi)].map((m) => m[1].toLowerCase())
  if (mentions.length !== 1) return { ok: false, error: mentions.length > 1 ? 'multiple-next' : 'invalid-next' }
  const mention = mentions[0]
  const next: SerialNext = mention === 'user' ? '@user' : (mention as AgentName)
  if (next !== '@user' && !AGENTS.has(next)) return { ok: false, error: 'invalid-next' }
  // consensus is a terminal state. Some models still leave the previous next-agent
  // mention in place; prefer stopping the discussion over treating that as failure.
  if (status === 'consensus') return { ok: true, next: '@user', status }
  return { ok: true, next, status }
}

export function selectNextAgentFromDirective(
  directive: SerialDirective,
  participants: AgentName[],
  current: AgentName,
): AgentName | null {
  if (!directive.ok || !directive.next || directive.next === '@user') return null
  if (directive.next === current) return null
  return participants.includes(directive.next) ? directive.next : null
}
