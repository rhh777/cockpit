import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentName, Source } from '../loaders/types'
import { groupThreadDir } from './group-thread-store'

export type ReviewSourceKind =
  | 'native-session'
  | 'cockpit-followup'
  | 'group-thread'
  | 'repository'
  | 'directory'
  | 'files'
  | 'document'
  | 'freeform'

export type ReviewPhase = 'draft' | 'review' | 'compare' | 'fix' | 'verify' | 'done'

export interface ReviewRoomPathSource {
  kind: 'repository' | 'directory' | 'file' | 'document'
  path: string
  name: string
}

export interface ReviewRoomSource {
  kind: ReviewSourceKind
  title: string
  cwd: string | null
  snapshotCreatedAt: string
  nativeSession?: {
    source: Source
    sessionId: string
  }
  groupThreadId?: string
  paths?: ReviewRoomPathSource[]
  freeformText?: string
  sourceSnapshot?: {
    eventCount?: number
    summaryRevision?: number
    fileMtimeMs?: number
    gitHead?: string
  }
}

export interface ReviewRound {
  id: string
  kind: 'review' | 'fix' | 'verify' | 'fresh-review'
  mode: 'parallel' | 'serial' | 'single'
  startedAt: string
  completedAt?: string
  agents: AgentName[]
  groupTurnId?: string
  status: 'running' | 'completed' | 'failed' | 'aborted'
}

export type IssueSeverity = 'blocker' | 'major' | 'minor' | 'nit'
export type VerifyOutcome = 'verified' | 'still-broken' | 'needs-discussion'

export interface ReviewIssue {
  id: string
  agent: AgentName
  title: string
  severity: IssueSeverity
  path?: string
  line?: number
  body: string
  // fix/verify 轮里回填的引用与结果。
  refIssueIds?: string[]
  outcome?: VerifyOutcome
}

export interface ReviewIssueSet {
  id: string
  reviewRoomId: string
  roundId: string
  createdAt: string
  issues: ReviewIssue[]
  agreements: string[]
  disagreements: string[]
  recommendedNextStep?: string
}

export interface FreshReviewLink {
  parentReviewRoomId: string
  childReviewRoomId: string
  handoffId?: string
  reviewerAgents: AgentName[]
  createdAt: string
  reason: 'verify' | 'new-risks' | 'user-requested'
}

export interface ReviewRoomDiskState {
  version: 1
  reviewRoomId: string
  groupThreadId: string
  source: ReviewRoomSource
  goal: string
  preset: string | null
  phase: ReviewPhase
  participants: AgentName[]
  rounds: ReviewRound[]
  issueSets: ReviewIssueSet[]
  freshReviews: FreshReviewLink[]
  createdAt: string
  updatedAt: string
}

export function reviewStateFile(groupThreadId: string): string {
  return path.join(groupThreadDir(groupThreadId), 'review-state.json')
}

async function readJsonFile<T>(file: string): Promise<T | null> {
  let raw: string
  try {
    raw = await fsp.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw err
  }
  try {
    return JSON.parse(raw) as T
  } catch (err) {
    throw new Error(`corrupt review-state.json (${file}): ${String((err as Error)?.message ?? err)}`)
  }
}

const queues = new Map<string, Promise<unknown>>()

function enqueue<T>(id: string, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(id) ?? Promise.resolve()
  const next = prev.then(task, task)
  queues.set(id, next.catch(() => {}))
  return next
}

async function writeState(state: ReviewRoomDiskState): Promise<void> {
  await fsp.writeFile(reviewStateFile(state.groupThreadId), JSON.stringify(state, null, 2) + '\n', 'utf8')
}

export const reviewRoomStore = {
  read(groupThreadId: string): Promise<ReviewRoomDiskState | null> {
    return readJsonFile<ReviewRoomDiskState>(reviewStateFile(groupThreadId))
  },

  async create(input: {
    groupThreadId: string
    source: ReviewRoomSource
    goal: string
    preset?: string | null
    participants: AgentName[]
    phase?: ReviewPhase
  }): Promise<ReviewRoomDiskState> {
    return enqueue(input.groupThreadId, async () => {
      const now = new Date().toISOString()
      const state: ReviewRoomDiskState = {
        version: 1,
        reviewRoomId: input.groupThreadId,
        groupThreadId: input.groupThreadId,
        source: input.source,
        goal: input.goal,
        preset: input.preset ?? null,
        phase: input.phase ?? 'draft',
        participants: [...new Set(input.participants)],
        rounds: [],
        issueSets: [],
        freshReviews: [],
        createdAt: now,
        updatedAt: now,
      }
      await writeState(state)
      return state
    })
  },

  async completeRound(
    groupThreadId: string,
    roundId: string,
    status: 'completed' | 'failed' | 'aborted',
  ): Promise<ReviewRoomDiskState | null> {
    return enqueue(groupThreadId, async () => {
      const current = await this.read(groupThreadId)
      if (!current) return null
      const next: ReviewRoomDiskState = {
        ...current,
        rounds: current.rounds.map((r) =>
          r.id === roundId ? { ...r, status, completedAt: r.completedAt ?? new Date().toISOString() } : r,
        ),
        updatedAt: new Date().toISOString(),
      }
      await writeState(next)
      return next
    })
  },

  async linkFreshReview(
    parentGroupThreadId: string,
    link: Omit<FreshReviewLink, 'createdAt' | 'parentReviewRoomId'>,
  ): Promise<ReviewRoomDiskState | null> {
    return enqueue(parentGroupThreadId, async () => {
      const current = await this.read(parentGroupThreadId)
      if (!current) return null
      const next: ReviewRoomDiskState = {
        ...current,
        freshReviews: [
          ...current.freshReviews.filter((f) => f.childReviewRoomId !== link.childReviewRoomId),
          { ...link, parentReviewRoomId: parentGroupThreadId, createdAt: new Date().toISOString() },
        ],
        updatedAt: new Date().toISOString(),
      }
      await writeState(next)
      return next
    })
  },

  async saveIssueSet(
    groupThreadId: string,
    roundId: string,
    input: {
      issues: ReviewIssue[]
      agreements?: string[]
      disagreements?: string[]
      recommendedNextStep?: string
    },
  ): Promise<ReviewRoomDiskState | null> {
    return enqueue(groupThreadId, async () => {
      const current = await this.read(groupThreadId)
      if (!current) return null
      const now = new Date().toISOString()
      const filtered = current.issueSets.filter((s) => s.roundId !== roundId)
      const set: ReviewIssueSet = {
        id: randomUUID(),
        reviewRoomId: groupThreadId,
        roundId,
        createdAt: now,
        issues: input.issues,
        agreements: input.agreements ?? [],
        disagreements: input.disagreements ?? [],
        recommendedNextStep: input.recommendedNextStep,
      }
      const next: ReviewRoomDiskState = {
        ...current,
        // 完成 review round 后进入 compare;fix/verify 保留 startRound 里已设的 phase。
        phase: current.rounds.find((r) => r.id === roundId)?.kind === 'review' ? 'compare' : current.phase,
        issueSets: [...filtered, set],
        updatedAt: now,
      }
      await writeState(next)
      return next
    })
  },

  async startRound(
    groupThreadId: string,
    round: Omit<ReviewRound, 'id' | 'startedAt' | 'status'> & Partial<Pick<ReviewRound, 'status'>>,
  ): Promise<ReviewRoomDiskState | null> {
    return enqueue(groupThreadId, async () => {
      const current = await this.read(groupThreadId)
      if (!current) return null
      const next: ReviewRoomDiskState = {
        ...current,
        phase: round.kind === 'review' ? 'review' : round.kind === 'fix' ? 'fix' : 'verify',
        rounds: [
          ...current.rounds,
          {
            id: randomUUID(),
            startedAt: new Date().toISOString(),
            status: round.status ?? 'running',
            ...round,
          },
        ],
        updatedAt: new Date().toISOString(),
      }
      await writeState(next)
      return next
    })
  },
}
