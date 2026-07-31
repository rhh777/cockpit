import type { ReviewRoomDiskState } from '../store/review-room-store'
import { summarizeIssueStatuses } from './issue-status'

const PHASE_NEXT: Record<ReviewRoomDiskState['phase'], string> = {
  draft: 'Start the first review round.',
  review: 'Wait for the active review round to finish.',
  compare: 'Resolve findings, choose a fixer, or finish the review.',
  fix: 'Complete the fix, then start verification.',
  verify: 'Review verification results and close or reopen findings.',
  done: 'Review Room is closed. Reopen it if more work is required.',
}

export function renderReviewRoomSummary(state: ReviewRoomDiskState): string {
  const status = summarizeIssueStatuses(state.rounds, state.issueSets, state.statusOverrides)
  const latestReview = [...state.rounds].reverse().find((round) => round.kind === 'review' && round.status === 'completed')
  const issueSet = latestReview ? state.issueSets.find((set) => set.roundId === latestReview.id) : undefined
  const decisions = state.conclusion?.trim()
    ? state.conclusion.trim()
    : issueSet?.agreements.length
      ? issueSet.agreements.map((item) => `- ${item}`).join('\n')
      : '_(none recorded)_'
  const openIssues = status.open + status.needsCheck
  const tasks = issueSet?.issues.length
    ? [
        `- ${openIssues} issue(s) still require action or checking.`,
        `- ${status.fixed} fixed; ${status.wontfix} accepted without a fix.`,
      ].join('\n')
    : '- No structured findings have been extracted yet.'

  return [
    '# Review Room Summary',
    '',
    '## Goal',
    '',
    state.goal || '_(none)_',
    '',
    '## Workflow State',
    '',
    `- Phase: ${state.phase}`,
    `- Participants: ${state.participants.join(', ') || '_(none)_'}`,
    `- Rounds: ${state.rounds.length}`,
    `- Findings: ${status.total} total; ${status.open} open; ${status.needsCheck} needs check; ${status.fixed} fixed; ${status.wontfix} accepted`,
    '',
    '## Decisions',
    '',
    decisions,
    '',
    '## Tasks',
    '',
    tasks,
    '',
    '## Next Step',
    '',
    PHASE_NEXT[state.phase],
    '',
    '## Source',
    '',
    `- Kind: ${state.source.kind}`,
    `- Title: ${state.source.title}`,
    `- Snapshot: ${state.source.snapshotCreatedAt}`,
    state.source.cwd ? `- Workspace: ${state.source.cwd}` : '- Workspace: _(none)_',
    '',
  ].join('\n')
}
