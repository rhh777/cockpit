import type { AgentName } from '../loaders/types'

/** `@all` 一类的全员 mention 解析成这个目标,由调用方按当前花名册展开。 */
export type MentionTarget = AgentName | 'all'
export type MentionScan = { agents: AgentName[]; all: boolean }

// ASCII 别名靠 \b 收尾(避免 @allen 命中 @all);中文别名没有词边界概念,单列一支。
const MENTION_RE = /@(claude|codex|opencode|cursor|all|everyone)\b|@(所有人|全体|大家)/gi

function stripInlineCode(line: string): string {
  return line.replace(/`[^`]*`/g, ' ')
}

function toTarget(raw: string): MentionTarget {
  const key = raw.toLowerCase()
  if (key === 'all' || key === 'everyone' || raw === '所有人' || raw === '全体' || raw === '大家') return 'all'
  return key as AgentName
}

export function scanMentions(text: string): MentionScan {
  const agents = new Set<AgentName>()
  let all = false
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
      const target = toTarget(m[1] ?? m[2])
      if (target === 'all') all = true
      else agents.add(target)
    }
  }

  return { agents: [...agents], all }
}

export function parseMentions(text: string): AgentName[] {
  return scanMentions(text).agents
}

/** @all 展开成整个花名册;否则只保留花名册内的显式 mention。 */
export function resolveMentionTargets(text: string, roster: AgentName[]): AgentName[] {
  const scan = scanMentions(text)
  if (scan.all) return [...roster]
  const rosterSet = new Set(roster)
  return scan.agents.filter((a) => rosterSet.has(a))
}
