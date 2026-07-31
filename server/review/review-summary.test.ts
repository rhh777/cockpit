import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReviewRoomDiskState } from '../store/review-room-store'
import { renderReviewRoomSummary } from './review-summary'

test('Review Room summary records workflow state, decisions, tasks, and source', () => {
  const state: ReviewRoomDiskState = {
    version: 1,
    reviewRoomId: 'r1', groupThreadId: 'r1',
    source: { kind: 'repository', title: 'cockpit', cwd: '/workspace/cockpit', snapshotCreatedAt: '2026-07-31T00:00:00Z' },
    goal: 'Ship safely', preset: 'implementation-review', phase: 'done', participants: ['claude', 'codex'],
    rounds: [{ id: 'review-1', kind: 'review', mode: 'parallel', startedAt: 'x', status: 'completed', agents: ['claude', 'codex'] }],
    issueSets: [{
      id: 'set-1', reviewRoomId: 'r1', roundId: 'review-1', createdAt: 'x', agreements: [], disagreements: [],
      issues: [{ id: 'i1', agent: 'codex', title: 'Guard API', severity: 'blocker', body: '' }],
    }],
    freshReviews: [], conclusion: 'Ready to release.', createdAt: 'x', updatedAt: 'x',
  }
  const markdown = renderReviewRoomSummary(state)
  assert.match(markdown, /# Review Room Summary/)
  assert.match(markdown, /Phase: done/)
  assert.match(markdown, /Ready to release\./)
  assert.match(markdown, /1 issue\(s\) still require action/)
  assert.match(markdown, /Kind: repository/)
})
