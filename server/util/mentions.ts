import type { AgentName } from '../loaders/types'

const MENTION_RE = /@(claude|codex)\b/gi

function stripInlineCode(line: string): string {
  return line.replace(/`[^`]*`/g, ' ')
}

export function parseMentions(text: string): AgentName[] {
  const out = new Set<AgentName>()
  let inFence = false

  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (/^```/.test(trimmed) || /^~~~/.test(trimmed)) {
      inFence = !inFence
      continue
    }
    if (inFence || trimmed.startsWith('>')) continue

    const line = stripInlineCode(rawLine)

    MENTION_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = MENTION_RE.exec(line)) !== null) {
      out.add(m[1].toLowerCase() as AgentName)
    }
  }

  return [...out]
}
