import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentName } from '../loaders/types'
import type { FreshReviewLink, ReviewIssue, ReviewRoomDiskState, ReviewRound } from '../store/review-room-store'
import { deriveFreshReviewResult, rollupFreshReviews } from './fresh-review-link'

const TS = '2026-07-31T00:00:00.000Z'

function link(childId: string): FreshReviewLink {
  return {
    parentReviewRoomId: 'parent',
    childReviewRoomId: childId,
    reviewerAgents: ['codex'] as AgentName[],
    createdAt: TS,
    reason: 'user-requested',
  }
}

function issue(id: string): ReviewIssue {
  return { id, agent: 'codex' as AgentName, title: id, severity: 'major', body: '' }
}

function child(input: {
  rounds?: ReviewRound[]
  issues?: { roundId: string; issues: ReviewIssue[] }[]
  phase?: ReviewRoomDiskState['phase']
}): ReviewRoomDiskState {
  return {
    version: 1,
    reviewRoomId: 'c1',
    groupThreadId: 'c1',
    source: { kind: 'freeform', title: 'child', cwd: null, snapshotCreatedAt: TS },
    goal: 'g',
    preset: null,
    phase: input.phase ?? 'compare',
    participants: ['codex'] as AgentName[],
    rounds: input.rounds ?? [],
    issueSets: (input.issues ?? []).map((s) => ({
      id: `set-${s.roundId}`,
      reviewRoomId: 'c1',
      roundId: s.roundId,
      createdAt: TS,
      issues: s.issues,
      agreements: [],
      disagreements: [],
    })),
    freshReviews: [],
    createdAt: TS,
    updatedAt: TS,
  }
}

function completedReview(id: string): ReviewRound {
  return {
    id,
    kind: 'review',
    mode: 'parallel',
    startedAt: TS,
    agents: ['codex'] as AgentName[],
    groupTurnId: `turn_${id}`,
    status: 'completed',
  }
}

test('child 还没跑 → completed=false 且 verified=false', () => {
  const r = deriveFreshReviewResult(link('c1'), child({}))
  assert.equal(r.completed, false)
  assert.equal(r.verified, false)
  assert.deepEqual(r.newIssues, [])
})

test('child 读不到(被删)→ 降级为未完成,不报错', () => {
  const r = deriveFreshReviewResult(link('c1'), null)
  assert.equal(r.completed, false)
  assert.equal(r.verified, false)
})

// 「还没查」和「查过没问题」必须区分开。
test('review 还在跑 → 不算 verified', () => {
  const running: ReviewRound = { ...completedReview('r1'), status: 'running' }
  const r = deriveFreshReviewResult(link('c1'), child({ rounds: [running] }))
  assert.equal(r.completed, false)
  assert.equal(r.verified, false)
})

test('child 提出新问题 → 回链新问题,不算 verified', () => {
  const c = child({
    rounds: [completedReview('r1')],
    issues: [{ roundId: 'r1', issues: [issue('codex-1'), issue('codex-2')] }],
  })
  const r = deriveFreshReviewResult(link('c1'), c)
  assert.equal(r.completed, true)
  assert.equal(r.verified, false)
  assert.equal(r.newIssues.length, 2)
})

test('child 完成且没提出问题 → verified', () => {
  const c = child({ rounds: [completedReview('r1')], issues: [{ roundId: 'r1', issues: [] }] })
  const r = deriveFreshReviewResult(link('c1'), c)
  assert.equal(r.completed, true)
  assert.equal(r.verified, true)
})

test('取最近一轮已完成 review 的结果', () => {
  const c = child({
    rounds: [completedReview('r1'), completedReview('r2')],
    issues: [
      { roundId: 'r1', issues: [issue('codex-old')] },
      { roundId: 'r2', issues: [issue('codex-new')] },
    ],
  })
  const r = deriveFreshReviewResult(link('c1'), c)
  assert.deepEqual(r.newIssues.map((i) => i.id), ['codex-new'])
})

test('rollup:任一 child 有新问题就 hasNewIssues', () => {
  const withIssues = deriveFreshReviewResult(
    link('c1'),
    child({ rounds: [completedReview('r1')], issues: [{ roundId: 'r1', issues: [issue('x')] }] }),
  )
  const clean = deriveFreshReviewResult(
    link('c2'),
    child({ rounds: [completedReview('r1')], issues: [{ roundId: 'r1', issues: [] }] }),
  )
  const rollup = rollupFreshReviews([withIssues, clean])
  assert.equal(rollup.hasNewIssues, true)
  assert.equal(rollup.newIssueCount, 1)
  // 有 child 提出了问题,就不能整体算 verified
  assert.equal(rollup.verified, false)
})

test('rollup:所有跑完的 child 都没问题 → verified', () => {
  const a = deriveFreshReviewResult(
    link('c1'),
    child({ rounds: [completedReview('r1')], issues: [{ roundId: 'r1', issues: [] }] }),
  )
  const pending = deriveFreshReviewResult(link('c2'), child({}))
  const rollup = rollupFreshReviews([a, pending])
  assert.equal(rollup.verified, true)
  assert.equal(rollup.hasNewIssues, false)
})

test('rollup:一个都没跑完 → 不算 verified', () => {
  const rollup = rollupFreshReviews([deriveFreshReviewResult(link('c1'), child({}))])
  assert.equal(rollup.verified, false)
})

test('rollup:没有 fresh review 时不算 verified', () => {
  const rollup = rollupFreshReviews([])
  assert.equal(rollup.verified, false)
  assert.equal(rollup.newIssueCount, 0)
})
