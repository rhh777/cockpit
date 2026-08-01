import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentName } from '../loaders/types'
import type { ReviewIssue, ReviewIssueSet, ReviewRound, VerifyOutcome } from '../store/review-room-store'
import { issueStatusKey } from '../store/review-room-store'
import {
  collectOutcomeTrail,
  resolveIssueStatus,
  statusFromOutcome,
  summarizeIssueStatuses,
} from './issue-status'

const NOW = '2026-07-31T00:00:00.000Z'

function issue(id: string, extra: Partial<ReviewIssue> = {}): ReviewIssue {
  return { id, agent: 'claude' as AgentName, title: id, severity: 'major', body: '', ...extra }
}

function round(id: string, kind: ReviewRound['kind']): ReviewRound {
  return {
    id,
    kind,
    mode: kind === 'fix' ? 'single' : 'parallel',
    startedAt: NOW,
    agents: ['claude'] as AgentName[],
    groupTurnId: `turn_${id}`,
    status: 'completed',
  }
}

function set(roundId: string, issues: ReviewIssue[]): ReviewIssueSet {
  return {
    id: `set-${roundId}`,
    reviewRoomId: 'g1',
    roundId,
    createdAt: NOW,
    issues,
    agreements: [],
    disagreements: [],
  }
}

function result(refId: string, outcome: VerifyOutcome): ReviewIssue {
  return issue(`res-${refId}-${outcome}`, { refIssueIds: [refId], outcome })
}

test('statusFromOutcome 映射', () => {
  assert.equal(statusFromOutcome({ kind: 'fix', outcome: 'verified' }), 'needs-check')
  assert.equal(statusFromOutcome({ kind: 'verify', outcome: 'verified' }), 'fixed')
  assert.equal(statusFromOutcome({ kind: 'verify', outcome: 'still-broken' }), 'open')
  assert.equal(statusFromOutcome({ kind: 'verify', outcome: 'needs-discussion' }), 'needs-check')
})

test('没有 outcome 也没有人工状态 → open/default', () => {
  const r = resolveIssueStatus({
    roundId: 'r1',
    issue: issue('claude-1'),
    outcomeTrail: new Map(),
  })
  assert.deepEqual(r, { status: 'open', source: 'default' })
})

test('verify 轮的 outcome 派生出状态', () => {
  const rounds = [round('r1', 'review'), round('r2', 'verify')]
  const sets = [set('r1', [issue('claude-1')]), set('r2', [result('claude-1', 'verified')])]
  const trail = collectOutcomeTrail(rounds, sets)
  const r = resolveIssueStatus({ roundId: 'r1', issue: issue('claude-1'), outcomeTrail: trail })
  assert.deepEqual(r, { status: 'fixed', source: 'derived' })
})

test('fix 轮报告完成后先进入待确认', () => {
  const rounds = [round('r1', 'review'), round('r2', 'fix')]
  const sets = [set('r1', [issue('claude-1')]), set('r2', [result('claude-1', 'verified')])]
  const trail = collectOutcomeTrail(rounds, sets)
  const r = resolveIssueStatus({ roundId: 'r1', issue: issue('claude-1'), outcomeTrail: trail })
  assert.deepEqual(r, { status: 'needs-check', source: 'derived' })
})

test('多轮 outcome 取最新一条', () => {
  const rounds = [round('r1', 'review'), round('r2', 'fix'), round('r3', 'verify')]
  const sets = [
    set('r1', [issue('claude-1')]),
    set('r2', [result('claude-1', 'verified')]),
    // 复核发现没真修好 → 最新状态应该是 open
    set('r3', [result('claude-1', 'still-broken')]),
  ]
  const trail = collectOutcomeTrail(rounds, sets)
  assert.equal(
    resolveIssueStatus({ roundId: 'r1', issue: issue('claude-1'), outcomeTrail: trail }).status,
    'open',
  )
})

test('人工状态优先于派生状态', () => {
  const rounds = [round('r1', 'review'), round('r2', 'verify')]
  const sets = [set('r1', [issue('claude-1')]), set('r2', [result('claude-1', 'verified')])]
  const trail = collectOutcomeTrail(rounds, sets)
  const r = resolveIssueStatus({
    roundId: 'r1',
    issue: issue('claude-1'),
    overrides: { [issueStatusKey('r1', 'claude-1')]: { status: 'wontfix', updatedAt: NOW } },
    outcomeTrail: trail,
  })
  assert.deepEqual(r, { status: 'wontfix', source: 'manual' })
})

test('人工状态按 roundId 隔离,不会串到别的轮次', () => {
  const overrides = { [issueStatusKey('r1', 'claude-1')]: { status: 'wontfix' as const, updatedAt: NOW } }
  const other = resolveIssueStatus({
    roundId: 'r9',
    issue: issue('claude-1'),
    overrides,
    outcomeTrail: new Map(),
  })
  assert.equal(other.source, 'default')
})

test('summarize 只统计最近一轮已完成 review 的 issue', () => {
  const rounds = [round('r1', 'review'), round('r2', 'verify')]
  const sets = [
    set('r1', [issue('claude-1'), issue('claude-2'), issue('claude-3')]),
    // verify 轮的条目是结果,不该被算成待办
    set('r2', [result('claude-1', 'verified')]),
  ]
  const s = summarizeIssueStatuses(rounds, sets)
  assert.equal(s.total, 3)
  assert.equal(s.fixed, 1)
  assert.equal(s.open, 2)
  assert.equal(s.allResolved, false)
})

test('全部 fixed / wontfix 时 allResolved 为 true', () => {
  const rounds = [round('r1', 'review'), round('r2', 'verify')]
  const sets = [
    set('r1', [issue('claude-1'), issue('claude-2')]),
    set('r2', [result('claude-1', 'verified')]),
  ]
  const overrides = { [issueStatusKey('r1', 'claude-2')]: { status: 'wontfix' as const, updatedAt: NOW } }
  const s = summarizeIssueStatuses(rounds, sets, overrides)
  assert.equal(s.fixed, 1)
  assert.equal(s.wontfix, 1)
  assert.equal(s.allResolved, true)
})

test('needs-check 不算已收口', () => {
  const rounds = [round('r1', 'review')]
  const sets = [set('r1', [issue('claude-1')])]
  const overrides = { [issueStatusKey('r1', 'claude-1')]: { status: 'needs-check' as const, updatedAt: NOW } }
  const s = summarizeIssueStatuses(rounds, sets, overrides)
  assert.equal(s.needsCheck, 1)
  assert.equal(s.allResolved, false)
})

test('没有已完成 review 轮时不算已收口', () => {
  assert.equal(summarizeIssueStatuses([], []).allResolved, false)
  const running: ReviewRound = { ...round('r1', 'review'), status: 'running' }
  assert.equal(summarizeIssueStatuses([running], [set('r1', [issue('claude-1')])]).allResolved, false)
})

test('空 issue 列表不算已收口(避免空房间被当成完成)', () => {
  const rounds = [round('r1', 'review')]
  const s = summarizeIssueStatuses(rounds, [set('r1', [])])
  assert.equal(s.total, 0)
  assert.equal(s.allResolved, false)
})
