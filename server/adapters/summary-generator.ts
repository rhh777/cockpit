import type { EventEnvelope, NormalizedEvent } from '../loaders/types'
import { redactSecrets } from './sensitive'

// Phase 4 — summary.md 生成器。
//
// 默认走「启发式」策略:不发模型请求,纯本地聚合。目的是把长 session 中已经"看过"的原生历史
// 压缩成一段可复用的自然语言块,交给下一轮 agent 当作 context prefix。
//
// 后续若要接 LLM 生成,不用改调用点:实现一个新的 SummaryGenerator 并在 registry 处切换即可。

export interface SummaryInput {
  sourceId: string
  events: EventEnvelope[] // 已合并 (native + boundary + follow-up),按 append 顺序
  priorSummary?: string
}

export interface SummaryOutput {
  markdown: string
  // 摘要覆盖到的最后一条 sourceEventId(原生段末尾),供 checkpoint 存储。
  // 找不到合适 anchor 时返回 undefined,调用方视为无法建立 checkpoint。
  anchorSourceEventId?: string
  // 原生段事件总数(用于比对是否需要重新生成)。
  nativeEventCount: number
}

export interface SummaryGenerator {
  generate(input: SummaryInput): Promise<SummaryOutput>
}

const DEFAULT_MAX_CHARS = 3200
const MAX_USER_GOAL_CHARS = 500
const MAX_USER_LINE_CHARS = 220
const MAX_ASSISTANT_TAIL_CHARS = 800
const MAX_TOOL_ERROR_LINE_CHARS = 300

function clip(s: string, n: number): string {
  const t = s.trim().replace(/\s+/g, ' ')
  if (t.length <= n) return t
  return t.slice(0, n) + '…'
}

function splitAtBoundary(events: EventEnvelope[]): {
  native: EventEnvelope[]
  followup: EventEnvelope[]
  anchor?: string
} {
  const idx = events.findIndex((e) => e.event.type === 'followup_boundary')
  const native = idx === -1 ? events : events.slice(0, idx)
  const followup = idx === -1 ? [] : events.slice(idx + 1)
  // anchor 取原生段最后一条真实事件(不含 boundary 自身)。
  let anchor: string | undefined
  for (let i = native.length - 1; i >= 0; i--) {
    const id = native[i].sourceEventId
    if (id) {
      anchor = id
      break
    }
  }
  return { native, followup, anchor }
}

function summarizeToolActivity(events: EventEnvelope[]): { line: string; errors: string[] } {
  const counts = new Map<string, number>()
  const errors: string[] = []
  for (const env of events) {
    const e = env.event
    if (e.type === 'tool_use') {
      counts.set(e.name, (counts.get(e.name) ?? 0) + 1)
    } else if (e.type === 'tool_result' && e.isError) {
      errors.push(clip(redactSecrets(e.output).text, MAX_TOOL_ERROR_LINE_CHARS))
    }
  }
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, n]) => `${name}×${n}`)
  return {
    line: parts.length > 0 ? parts.join(', ') : '(无工具调用)',
    errors: errors.slice(0, 3),
  }
}

function firstAndRecentUserTexts(events: EventEnvelope[]): { first?: string; recent: string[] } {
  const users = events
    .map((e) => e.event)
    .filter((e): e is Extract<NormalizedEvent, { type: 'user_text' }> => e.type === 'user_text')
  const first = users[0]?.text
  const recent = users
    .slice(1)
    .slice(-5)
    .map((u) => clip(u.text, MAX_USER_LINE_CHARS))
  return { first: first ? clip(first, MAX_USER_GOAL_CHARS) : undefined, recent }
}

function lastAssistantText(events: EventEnvelope[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i].event
    if (e.type === 'assistant_text') return clip(e.text, MAX_ASSISTANT_TAIL_CHARS)
  }
  return undefined
}

export const heuristicSummaryGenerator: SummaryGenerator = {
  async generate(input) {
    const { native, followup, anchor } = splitAtBoundary(input.events)
    const userGoals = firstAndRecentUserTexts(native)
    const followupGoals = firstAndRecentUserTexts(followup)
    const tools = summarizeToolActivity(native)
    const lastAsst = lastAssistantText(native)

    const lines: string[] = []
    lines.push(`# Session summary`)
    lines.push('')
    if (userGoals.first) {
      lines.push(`## 初始目标`)
      lines.push(userGoals.first)
      lines.push('')
    }
    if (userGoals.recent.length > 0) {
      lines.push(`## 主要用户消息(原生段最近 ${userGoals.recent.length} 条)`)
      for (const u of userGoals.recent) lines.push(`- ${u}`)
      lines.push('')
    }
    lines.push(`## 工具活动`)
    lines.push(tools.line)
    if (tools.errors.length > 0) {
      lines.push('')
      lines.push(`### 错误摘录`)
      for (const err of tools.errors) lines.push(`- ${err}`)
    }
    lines.push('')
    if (lastAsst) {
      lines.push(`## 上一轮 assistant 回复(片段)`)
      lines.push(lastAsst)
      lines.push('')
    }
    if (followupGoals.first) {
      lines.push(`## Cockpit follow-up 累积主题`)
      lines.push(`- ${followupGoals.first}`)
      for (const u of followupGoals.recent) lines.push(`- ${u}`)
    }

    let md = lines.join('\n').trim()
    if (md.length > DEFAULT_MAX_CHARS) md = md.slice(0, DEFAULT_MAX_CHARS) + '\n…[summary truncated]'
    // 尾部再跑一次密钥屏蔽,和 serialize 同层纵深防御。
    md = redactSecrets(md).text

    return {
      markdown: md,
      anchorSourceEventId: anchor,
      nativeEventCount: native.length,
    }
  },
}

let activeGenerator: SummaryGenerator = heuristicSummaryGenerator

export function getSummaryGenerator(): SummaryGenerator {
  return activeGenerator
}

// 预留接口:后续接 LLM generator 时在这里替换。测试也可以走这个 setter 注入 mock。
export function setSummaryGenerator(gen: SummaryGenerator): void {
  activeGenerator = gen
}
