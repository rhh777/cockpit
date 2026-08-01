import type { AgentName } from './types'

/** `@all` 一类的全员 mention 解析成这个目标,由调用方按当前花名册展开。 */
export type MentionTarget = AgentName | 'all'
export type MentionRange = { start: number; end: number; target: MentionTarget }
export type MentionScan = { agents: AgentName[]; all: boolean }

// ASCII 别名靠 \b 收尾(避免 @allen 命中 @all);中文别名没有词边界概念,单列一支。
const MENTION_RE = /@(claude|codex|opencode|cursor|all|everyone)\b|@(所有人|全体|大家)/gi

function maskInlineCode(line: string): string {
  // 用等长空格替换,保证 range 偏移量仍对得上原文。
  return line.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length))
}

function toTarget(raw: string): MentionTarget {
  const key = raw.toLowerCase()
  if (key === 'all' || key === 'everyone' || raw === '所有人' || raw === '全体' || raw === '大家') return 'all'
  return key as AgentName
}

/** 返回文本里每个生效 mention 的字符区间(inline code / 引用 / 代码块内的不算)。 */
export function scanMentionRanges(text: string): MentionRange[] {
  const ranges: MentionRange[] = []
  let inFence = false
  let offset = 0

  for (const rawLine of text.split('\n')) {
    const lineStart = offset
    offset += rawLine.length + 1

    const trimmed = rawLine.trim()
    if (/^```/.test(trimmed) || /^~~~/.test(trimmed)) {
      inFence = !inFence
      continue
    }
    if (inFence || trimmed.startsWith('>')) continue

    const line = maskInlineCode(rawLine)

    MENTION_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = MENTION_RE.exec(line)) !== null) {
      ranges.push({
        start: lineStart + m.index,
        end: lineStart + m.index + m[0].length,
        target: toTarget(m[1] ?? m[2]),
      })
    }
  }

  return ranges
}

export function scanMentions(text: string): MentionScan {
  const agents = new Set<AgentName>()
  let all = false
  for (const range of scanMentionRanges(text)) {
    if (range.target === 'all') all = true
    else agents.add(range.target)
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

export type MentionSegment = { text: string; target?: MentionTarget }

/** 把文本切成「普通片段 + mention 片段」,供 composer 的高亮背板渲染。 */
export function splitMentionSegments(text: string): MentionSegment[] {
  const ranges = scanMentionRanges(text)
  if (ranges.length === 0) return [{ text }]
  const segments: MentionSegment[] = []
  let cursor = 0
  for (const range of ranges) {
    if (range.start > cursor) segments.push({ text: text.slice(cursor, range.start) })
    segments.push({ text: text.slice(range.start, range.end), target: range.target })
    cursor = range.end
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) })
  return segments
}
