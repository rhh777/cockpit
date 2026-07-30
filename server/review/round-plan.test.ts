import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentName } from '../loaders/types'
import type { ReviewIssue, ReviewRoomDiskState, ReviewRound } from '../store/review-room-store'
import { defaultFixer, planReviewRound, RoundPlanError } from './round-plan'

function issue(agent: AgentName, title: string): ReviewIssue {
  return { id: `${agent}-${title}`, agent, title, severity: 'major', body: '' }
}

function room(input: {
  participants?: AgentName[]
  rounds?: ReviewRound[]
  issues?: { roundId: string; issues: ReviewIssue[] }[]
} = {}): ReviewRoomDiskState {
  const now = '2026-07-30T00:00:00.000Z'
  return {
    version: 1,
    reviewRoomId: 'g1',
    groupThreadId: 'g1',
    source: { kind: 'freeform', title: 'T', cwd: null, snapshotCreatedAt: now },
    goal: 'g',
    preset: null,
    phase: 'compare',
    participants: input.participants ?? (['claude', 'codex'] as AgentName[]),
    rounds: input.rounds ?? [],
    issueSets: (input.issues ?? []).map((s) => ({
      id: `set-${s.roundId}`,
      reviewRoomId: 'g1',
      roundId: s.roundId,
      createdAt: now,
      issues: s.issues,
      agreements: [],
      disagreements: [],
    })),
    freshReviews: [],
    createdAt: now,
    updatedAt: now,
  }
}

function completedReview(id: string): ReviewRound {
  return {
    id,
    kind: 'review',
    mode: 'parallel',
    startedAt: '2026-07-30T00:00:00.000Z',
    agents: ['claude', 'codex'] as AgentName[],
    groupTurnId: `turn_${id}`,
    status: 'completed',
  }
}

test('planReviewRound: review 轮保持并行唤醒全部 participants', () => {
  const plan = planReviewRound({ kind: 'review', mode: 'parallel', review: room(), groupAgents: [] })
  assert.deepEqual(plan.participants, ['claude', 'codex'])
  assert.equal(plan.runMode, 'parallel')
  assert.equal(plan.roundMode, 'parallel')
})

test('planReviewRound: review 轮 serial 模式原样透传', () => {
  const plan = planReviewRound({ kind: 'review', mode: 'serial', review: room(), groupAgents: [] })
  assert.equal(plan.runMode, 'serial')
  assert.equal(plan.roundMode, 'serial')
  assert.equal(plan.participants.length, 2)
})

// 核心安全约束(docs/14 §Fix:多 agent 不并行写文件)。
test('planReviewRound: fix 轮永远只唤醒一个 writer', () => {
  const plan = planReviewRound({ kind: 'fix', mode: 'parallel', review: room(), groupAgents: [] })
  assert.equal(plan.participants.length, 1)
  assert.equal(plan.roundMode, 'single')
})

test('planReviewRound: fix 轮把 serial 降为单发,不走接力 orchestrator', () => {
  const plan = planReviewRound({ kind: 'fix', mode: 'serial', review: room(), groupAgents: [] })
  assert.equal(plan.participants.length, 1)
  assert.equal(plan.runMode, 'parallel')
  assert.equal(plan.roundMode, 'single')
})

test('planReviewRound: fix 轮显式传多个 fixer 被拒绝', () => {
  assert.throws(
    () =>
      planReviewRound({
        kind: 'fix',
        mode: 'parallel',
        participantsOverride: ['claude', 'codex'] as AgentName[],
        review: room(),
        groupAgents: [],
      }),
    RoundPlanError,
  )
})

test('planReviewRound: fix 轮尊重用户显式指定的单个 fixer', () => {
  const plan = planReviewRound({
    kind: 'fix',
    mode: 'parallel',
    participantsOverride: ['codex'] as AgentName[],
    review: room(),
    groupAgents: [],
  })
  assert.deepEqual(plan.participants, ['codex'])
})

test('planReviewRound: verify 轮允许多 agent 复核', () => {
  const plan = planReviewRound({ kind: 'verify', mode: 'parallel', review: room(), groupAgents: [] })
  assert.equal(plan.participants.length, 2)
  assert.equal(plan.roundMode, 'parallel')
})

test('planReviewRound: participants 为空时回落 group.agents', () => {
  const plan = planReviewRound({
    kind: 'review',
    mode: 'parallel',
    review: room({ participants: [] }),
    groupAgents: ['claude'] as AgentName[],
  })
  assert.deepEqual(plan.participants, ['claude'])
})

test('planReviewRound: 完全没有 participants 时报错', () => {
  assert.throws(
    () => planReviewRound({ kind: 'review', mode: 'parallel', review: room({ participants: [] }), groupAgents: [] }),
    RoundPlanError,
  )
})

test('defaultFixer: 选提出问题较少的一方(非发现者)', () => {
  const state = room({
    rounds: [completedReview('r1')],
    issues: [
      {
        roundId: 'r1',
        issues: [issue('claude', 'a'), issue('claude', 'b'), issue('claude', 'c'), issue('codex', 'd')],
      },
    ],
  })
  assert.equal(defaultFixer(state, ['claude', 'codex'] as AgentName[]), 'codex')
})

test('defaultFixer: 并列时按 pool 顺序稳定取第一个', () => {
  const state = room({
    rounds: [completedReview('r1')],
    issues: [{ roundId: 'r1', issues: [issue('claude', 'a'), issue('codex', 'b')] }],
  })
  assert.equal(defaultFixer(state, ['codex', 'claude'] as AgentName[]), 'codex')
  assert.equal(defaultFixer(state, ['claude', 'codex'] as AgentName[]), 'claude')
})

test('defaultFixer: 还没有 issueSet 时取 pool 首位', () => {
  assert.equal(defaultFixer(room(), ['claude', 'codex'] as AgentName[]), 'claude')
})

test('defaultFixer: 只看最近一轮已完成 review 的 issueSet', () => {
  const older = completedReview('r1')
  const newer = completedReview('r2')
  const state = room({
    rounds: [older, newer],
    issues: [
      // 旧轮 codex 提得多;新轮反过来 —— 应按新轮判断,fixer = claude。
      { roundId: 'r1', issues: [issue('codex', 'a'), issue('codex', 'b'), issue('claude', 'c')] },
      { roundId: 'r2', issues: [issue('codex', 'd'), issue('claude', 'e')] },
    ],
  })
  const stateWithSkew = {
    ...state,
    issueSets: state.issueSets.map((s) =>
      s.roundId === 'r2' ? { ...s, issues: [...s.issues, issue('codex', 'f')] } : s,
    ),
  }
  assert.equal(defaultFixer(stateWithSkew, ['claude', 'codex'] as AgentName[]), 'claude')
})
