// Review Room 轮次调度约束(docs/14 §Fix / §Verify)。
//
// 抽成纯函数是为了让「fix 只能有一个 writer」这条安全约束可被单测覆盖:
// route 侧只负责读 store、调 runRegistry,不再自己决定唤醒几个 agent。

import type { AgentName } from '../loaders/types'
import type { ReviewRoomDiskState, ReviewRound } from '../store/review-room-store'

export type RoundKind = 'review' | 'fix' | 'verify'

export interface RoundPlan {
  /** 实际唤醒的 agent。fix 轮恒为 1 个。 */
  participants: AgentName[]
  /** 传给 `runRegistry.startGroupTurn` 的执行模式。 */
  runMode: 'parallel' | 'serial'
  /** 落盘到 `ReviewRound.mode` 的模式;fix 记 'single' 以区别于并行轮。 */
  roundMode: ReviewRound['mode']
}

export class RoundPlanError extends Error {}

/**
 * docs/14 §Fix:「默认由发现问题以外的 agent 修复」。
 *
 * 并行 review 里两位 reviewer 都提了问题,所以取「在最近一轮已完成 review 里提出问题最少」
 * 的那位 —— 对自己的结论锚定最少。并列(含还没有 issueSet)时按 pool 顺序取第一个,
 * 保证同一个 room 的默认值稳定可预测。
 */
export function defaultFixer(review: ReviewRoomDiskState, pool: AgentName[]): AgentName {
  const lastReview = [...review.rounds].reverse().find((r) => r.kind === 'review' && r.status === 'completed')
  const set = lastReview ? review.issueSets.find((s) => s.roundId === lastReview.id) : undefined
  if (!set) return pool[0]
  const counts = new Map<AgentName, number>(pool.map((a) => [a, 0]))
  for (const issue of set.issues) {
    if (counts.has(issue.agent)) counts.set(issue.agent, (counts.get(issue.agent) ?? 0) + 1)
  }
  let best = pool[0]
  for (const agent of pool) {
    if ((counts.get(agent) ?? 0) < (counts.get(best) ?? 0)) best = agent
  }
  return best
}

export function planReviewRound(input: {
  kind: RoundKind
  mode: 'parallel' | 'serial'
  participantsOverride?: AgentName[]
  review: ReviewRoomDiskState
  groupAgents: AgentName[]
}): RoundPlan {
  const override = input.participantsOverride?.length
    ? [...new Set(input.participantsOverride.filter((a): a is AgentName => typeof a === 'string' && a.length > 0))]
    : undefined
  const pool = override?.length
    ? override
    : input.review.participants.length
      ? input.review.participants
      : input.groupAgents
  if (pool.length === 0) throw new RoundPlanError('review room has no participants')

  // docs/14 §Fix:「多 agent 不并行写文件。Parallel review 只能只读;Fix 阶段只允许一个
  // selected fixer agent 运行」。fix 是唯一既带写权限又可能多 agent 的路径,约束在这里收口。
  if (input.kind === 'fix') {
    if (override && override.length > 1) {
      throw new RoundPlanError('fix round allows exactly one fixer agent (docs/14: no parallel writers)')
    }
    return {
      participants: [override?.[0] ?? defaultFixer(input.review, pool)],
      // serial orchestrator 对单 agent 没有意义(第一步就 no-next-agent),降为单发。
      runMode: 'parallel',
      roundMode: 'single',
    }
  }

  return { participants: pool, runMode: input.mode, roundMode: input.mode }
}
