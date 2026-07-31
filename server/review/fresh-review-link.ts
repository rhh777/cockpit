// Fresh Review 结果回链 parent(docs/14 §Fresh Review)。
//
// 设计要求:
//   - 新发现问题追加到 parent 的 issue set,状态为 open
//   - 如果没有新问题,parent 可以标记 verified
//   - child timeline 保留独立证据链
//
// 实现取舍:**不把 child 的 issue 写进 parent 的 issueSets**。parent 的 issueSet 会被
// saveIssueSet 整体替换(重新抽取),写进去会被冲掉;而且同一条问题就有了两个属主,
// 状态该听谁的会变得含糊。改为在读取时从 child 的 review-state 派生出一份只读视图:
// child 永远是这些问题的事实源(状态也在 child 房间里改),parent 只负责展示与汇总。
//
// 因此这里是纯函数 + 一次 child 状态读取,没有新的持久化字段,也就不存在「回链数据过期」。

import type { FreshReviewLink, ReviewIssue, ReviewRoomDiskState } from '../store/review-room-store'

export interface FreshReviewResult {
  childReviewRoomId: string
  /** child 是否已经跑完至少一轮 review 并抽到了结构化 findings。 */
  completed: boolean
  /** child 独立复核后提出的问题(parent 视角一律视为 open,状态在 child 房间里维护)。 */
  newIssues: ReviewIssue[]
  /** child 完成了 review 且没提出任何问题 —— docs/14:「如果没有新问题,parent 可以标记 verified」。 */
  verified: boolean
  childPhase?: ReviewRoomDiskState['phase']
}

/**
 * 从 child 的 review 状态派生回链结果。
 * child 还没跑完 review(没有已完成的 review 轮或没有 issueSet)时 completed=false,
 * 此时 verified 必须为 false —— 「还没查」和「查过没问题」是两件事。
 */
export function deriveFreshReviewResult(
  link: FreshReviewLink,
  child: ReviewRoomDiskState | null,
): FreshReviewResult {
  const base: FreshReviewResult = {
    childReviewRoomId: link.childReviewRoomId,
    completed: false,
    newIssues: [],
    verified: false,
  }
  if (!child) return base

  const lastReview = [...child.rounds]
    .reverse()
    .find((r) => r.kind === 'review' && r.status === 'completed')
  if (!lastReview) return { ...base, childPhase: child.phase }
  const set = child.issueSets.find((s) => s.roundId === lastReview.id)
  if (!set) return { ...base, childPhase: child.phase }

  return {
    childReviewRoomId: link.childReviewRoomId,
    completed: true,
    newIssues: set.issues,
    verified: set.issues.length === 0,
    childPhase: child.phase,
  }
}

export interface FreshReviewRollup {
  results: FreshReviewResult[]
  /** 有任何一个 child 提出了新问题。 */
  hasNewIssues: boolean
  /** 至少有一个 child 跑完了,且所有跑完的 child 都没提出新问题。 */
  verified: boolean
  newIssueCount: number
}

export function rollupFreshReviews(results: FreshReviewResult[]): FreshReviewRollup {
  const completed = results.filter((r) => r.completed)
  const newIssueCount = results.reduce((n, r) => n + r.newIssues.length, 0)
  return {
    results,
    hasNewIssues: newIssueCount > 0,
    verified: completed.length > 0 && completed.every((r) => r.verified),
    newIssueCount,
  }
}
