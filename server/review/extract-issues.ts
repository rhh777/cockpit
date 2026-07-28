import type { EventEnvelope } from '../loaders/types'
import type { AgentName } from '../loaders/types'
import type { IssueSeverity, ReviewIssue, VerifyOutcome } from '../store/review-room-store'

// 抽取协议:agent 在响应末尾追加
//
//   FINDINGS
//   ```json
//   { "issues": [ {title, severity, path?, line?, body} ], "agreements": [...], "disagreements": [...], "next": "…" }
//   ```
//
// 也接受直接给一个数组、大小写不敏感的 label、缺少 fence 语言标签。

const SEVERITIES: IssueSeverity[] = ['blocker', 'major', 'minor', 'nit']

function normalizeSeverity(raw: unknown): IssueSeverity {
  if (typeof raw !== 'string') return 'minor'
  const v = raw.trim().toLowerCase()
  return (SEVERITIES as string[]).includes(v) ? (v as IssueSeverity) : 'minor'
}

function coerceString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function coerceInt(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}

const OUTCOMES: VerifyOutcome[] = ['verified', 'still-broken', 'needs-discussion']

function normalizeOutcome(raw: unknown): VerifyOutcome | undefined {
  if (typeof raw !== 'string') return undefined
  const v = raw.trim().toLowerCase().replace(/[_\s]+/g, '-')
  if ((OUTCOMES as string[]).includes(v)) return v as VerifyOutcome
  if (v === 'fixed' || v === 'resolved') return 'verified'
  if (v === 'broken' || v === 'still' || v === 'unfixed' || v === 'deferred' || v === 'regression') return 'still-broken'
  if (v === 'discuss' || v === 'unclear') return 'needs-discussion'
  return undefined
}

function coerceRefIds(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) {
    const ids = raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    return ids.length ? ids : undefined
  }
  if (typeof raw === 'string' && raw.trim()) return [raw.trim()]
  return undefined
}

interface Parsed {
  issues: Omit<ReviewIssue, 'id' | 'agent'>[]
  agreements: string[]
  disagreements: string[]
  recommendedNextStep?: string
}

function firstJsonFence(text: string): string | null {
  // ```json ... ```  或 ``` ... ``` 或 无 fence 的裸 JSON(结尾整块)
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/g
  let m: RegExpExecArray | null
  while ((m = fence.exec(text))) {
    const chunk = m[1].trim()
    if (chunk.startsWith('{') || chunk.startsWith('[')) return chunk
  }
  // Fallback:找 FINDINGS 之后第一个 `{` 或 `[` 到匹配的结尾
  const idx = text.search(/findings/i)
  if (idx >= 0) {
    const tail = text.slice(idx)
    const open = tail.search(/[{[]/)
    if (open >= 0) return tail.slice(open).trim()
  }
  return null
}

function safeParse(chunk: string): unknown {
  try {
    return JSON.parse(chunk)
  } catch {
    // 尝试截掉末尾非法内容后再 parse(常见 LLM 输出结尾多逗号/多余文字)
    const lastClose = Math.max(chunk.lastIndexOf('}'), chunk.lastIndexOf(']'))
    if (lastClose > 0) {
      try {
        return JSON.parse(chunk.slice(0, lastClose + 1))
      } catch {
        return null
      }
    }
    return null
  }
}

export function parseFindingsBlock(text: string): Parsed | null {
  const chunk = firstJsonFence(text)
  if (!chunk) return null
  const raw = safeParse(chunk)
  if (raw == null) return null
  const rawObj = !Array.isArray(raw) && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const rawIssues: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray(rawObj.issues)
      ? (rawObj.issues as unknown[])
      : []
  const rawResults: unknown[] = Array.isArray(rawObj.results) ? (rawObj.results as unknown[]) : []
  const issues: Omit<ReviewIssue, 'id' | 'agent'>[] = []
  for (const it of rawIssues) {
    if (!it || typeof it !== 'object') continue
    const o = it as Record<string, unknown>
    const title = coerceString(o.title) ?? coerceString(o.summary) ?? coerceString(o.name)
    if (!title) continue
    const refIds = coerceRefIds(o.refIssueIds ?? o.refIssueId ?? o.issueId ?? o.issueIds)
    const outcome = normalizeOutcome(o.outcome ?? o.status)
    issues.push({
      title,
      severity: normalizeSeverity(o.severity),
      path: coerceString(o.path) ?? coerceString(o.file),
      line: coerceInt(o.line),
      body: coerceString(o.body) ?? coerceString(o.detail) ?? coerceString(o.description) ?? '',
      ...(refIds ? { refIssueIds: refIds } : {}),
      ...(outcome ? { outcome } : {}),
    })
  }
  // fix/verify 轮次:agents 应返回 results:[{refIssueId, outcome, note}]。这里映射成 ReviewIssue,
  // title 用 note 首行或 fallback 到 refId,body 是完整 note,severity 缺省 minor。
  for (const r of rawResults) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const refIds = coerceRefIds(o.refIssueIds ?? o.refIssueId ?? o.issueId ?? o.issueIds)
    const outcome = normalizeOutcome(o.outcome ?? o.status)
    if (!refIds && !outcome) continue
    const note = coerceString(o.note) ?? coerceString(o.body) ?? coerceString(o.detail) ?? ''
    const title =
      coerceString(o.title) ??
      (note ? note.split('\n')[0].slice(0, 120) : refIds ? `Result for ${refIds.join(', ')}` : 'Result')
    issues.push({
      title,
      severity: normalizeSeverity(o.severity ?? 'minor'),
      path: coerceString(o.path) ?? coerceString(o.file),
      line: coerceInt(o.line),
      body: note,
      ...(refIds ? { refIssueIds: refIds } : {}),
      ...(outcome ? { outcome } : {}),
    })
  }
  const strArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0) : []
  return {
    issues,
    agreements: strArray(rawObj.agreements),
    disagreements: strArray(rawObj.disagreements),
    recommendedNextStep: coerceString(rawObj.next) ?? coerceString(rawObj.recommendedNextStep),
  }
}

export interface RoundTexts {
  agent: AgentName
  text: string
}

// 合并同 agent 的多条 assistant_text(接力模式或 stream 断片)。
export function collectRoundTexts(events: EventEnvelope[], groupTurnId: string): RoundTexts[] {
  const buckets = new Map<AgentName, string[]>()
  for (const env of events) {
    const e = env.event
    if (env.turnId !== groupTurnId) continue
    if (e.type !== 'assistant_text' || e.delta) continue
    const agent = (e as { agent?: string }).agent as AgentName | undefined
    const text = typeof (e as { text?: string }).text === 'string' ? (e as { text: string }).text : ''
    if (!agent || !text) continue
    const list = buckets.get(agent) ?? []
    list.push(text)
    buckets.set(agent, list)
  }
  return [...buckets.entries()].map(([agent, chunks]) => ({ agent, text: chunks.join('\n\n') }))
}

export function extractIssuesForRound(
  events: EventEnvelope[],
  groupTurnId: string,
): { issues: ReviewIssue[]; agreements: string[]; disagreements: string[]; recommendedNextStep?: string } {
  const perAgent = collectRoundTexts(events, groupTurnId)
  const issues: ReviewIssue[] = []
  const agreements = new Set<string>()
  const disagreements = new Set<string>()
  let nextStep: string | undefined
  for (const { agent, text } of perAgent) {
    const parsed = parseFindingsBlock(text)
    if (!parsed) continue
    parsed.issues.forEach((it, idx) => {
      issues.push({ ...it, id: `${agent}-${idx + 1}`, agent })
    })
    for (const a of parsed.agreements) agreements.add(a)
    for (const d of parsed.disagreements) disagreements.add(d)
    if (!nextStep && parsed.recommendedNextStep) nextStep = parsed.recommendedNextStep
  }
  return {
    issues,
    agreements: [...agreements],
    disagreements: [...disagreements],
    recommendedNextStep: nextStep,
  }
}
