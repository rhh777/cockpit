// Review Room issue 状态解析(docs/14 §Compare / §Done)。
//
// 一条 issue 的「当前状态」有三个来源,优先级从高到低:
//   1. manual   —— 用户在 compare 视图里手动设的状态(statusOverrides,跨重新抽取存活)
//   2. derived  —— 后续 fix / verify 轮里 agent 对该 issue 给出的最新 outcome
//   3. default  —— 都没有则 open
//
// 抽成纯函数,便于单测,也保证前端不必复制这套优先级(route 在 DTO 里直接下发结果)。

import type {
  IssueStatusOverride,
  ReviewIssue,
  ReviewIssueSet,
  ReviewIssueStatus,
  ReviewRound,
  VerifyOutcome,
} from '../store/review-room-store'
import { issueStatusKey } from '../store/review-room-store'

export type IssueStatusSource = 'manual' | 'derived' | 'default'

export interface ResolvedIssueStatus {
  status: ReviewIssueStatus
  source: IssueStatusSource
}

/** verify/fix 轮的 outcome → issue 状态。 */
export function statusFromOutcome(outcome: VerifyOutcome): ReviewIssueStatus {
  if (outcome === 'verified') return 'fixed'
  if (outcome === 'needs-discussion') return 'needs-check'
  return 'open'
}

/**
 * 收集后续 fix/verify 轮里对各个 issue 的 outcome 轨迹。
 * 返回 issueId → 按轮次先后排列的 outcome 列表(只取最后一个用于派生状态)。
 */
export function collectOutcomeTrail(
  rounds: ReviewRound[],
  issueSets: ReviewIssueSet[],
): Map<string, VerifyOutcome[]> {
  const trail = new Map<string, VerifyOutcome[]>()
  // 按轮次在 rounds 里的顺序遍历,保证「最新 outcome」是时间序上的最后一个。
  for (const round of rounds) {
    if (round.kind !== 'fix' && round.kind !== 'verify') continue
    const set = issueSets.find((s) => s.roundId === round.id)
    if (!set) continue
    for (const issue of set.issues) {
      if (!issue.outcome || !issue.refIssueIds) continue
      for (const refId of issue.refIssueIds) {
        const list = trail.get(refId) ?? []
        list.push(issue.outcome)
        trail.set(refId, list)
      }
    }
  }
  return trail
}

export function resolveIssueStatus(input: {
  roundId: string
  issue: ReviewIssue
  overrides?: Record<string, IssueStatusOverride>
  outcomeTrail: Map<string, VerifyOutcome[]>
}): ResolvedIssueStatus {
  const manual = input.overrides?.[issueStatusKey(input.roundId, input.issue.id)]
  if (manual) return { status: manual.status, source: 'manual' }
  const outcomes = input.outcomeTrail.get(input.issue.id)
  const latest = outcomes?.[outcomes.length - 1]
  if (latest) return { status: statusFromOutcome(latest), source: 'derived' }
  return { status: 'open', source: 'default' }
}

export interface IssueStatusSummary {
  total: number
  open: number
  fixed: number
  wontfix: number
  needsCheck: number
  /** 全部为 fixed / wontfix —— docs/14 §Done 的自动收口条件。 */
  allResolved: boolean
}

/**
 * 汇总**最近一轮 review** 的 issue 状态(fix/verify 轮的 issue 是结果条目,不是待办本身,
 * 不计入)。没有已完成 review 轮时 total = 0,allResolved 为 false —— 空房间不算「已收口」。
 */
export function summarizeIssueStatuses(
  rounds: ReviewRound[],
  issueSets: ReviewIssueSet[],
  overrides?: Record<string, IssueStatusOverride>,
): IssueStatusSummary {
  const lastReview = [...rounds].reverse().find((r) => r.kind === 'review' && r.status === 'completed')
  const set = lastReview ? issueSets.find((s) => s.roundId === lastReview.id) : undefined
  const empty: IssueStatusSummary = {
    total: 0,
    open: 0,
    fixed: 0,
    wontfix: 0,
    needsCheck: 0,
    allResolved: false,
  }
  if (!lastReview || !set || set.issues.length === 0) return empty

  const outcomeTrail = collectOutcomeTrail(rounds, issueSets)
  const summary = { ...empty, total: set.issues.length }
  for (const issue of set.issues) {
    const { status } = resolveIssueStatus({ roundId: lastReview.id, issue, overrides, outcomeTrail })
    if (status === 'fixed') summary.fixed++
    else if (status === 'wontfix') summary.wontfix++
    else if (status === 'needs-check') summary.needsCheck++
    else summary.open++
  }
  summary.allResolved = summary.open === 0 && summary.needsCheck === 0
  return summary
}
