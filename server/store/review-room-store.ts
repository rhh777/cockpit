import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentName, Source } from '../loaders/types'
import { groupThreadDir, groupThreadStore } from './group-thread-store'
import { renderReviewRoomSummary } from '../review/review-summary'

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
    /** files / document 来源的逐文件 mtime 基线,用于 stale 检测(docs/14 §上下文来源)。 */
    pathMtimes?: { path: string; mtimeMs: number }[]
  }
}

export interface ReviewRound {
  id: string
  kind: 'review' | 'fix' | 'verify' | 'fresh-review'
  /** 'manual' = 用户自己动手修(docs/14 §Fix「I'll fix manually」),没有 agent run。 */
  mode: 'parallel' | 'serial' | 'single' | 'manual'
  startedAt: string
  completedAt?: string
  agents: AgentName[]
  groupTurnId?: string
  /** 'awaiting-user' 只用于手动修复轮:不是 agent 在跑,而是在等用户动手。 */
  status: 'running' | 'completed' | 'failed' | 'aborted' | 'awaiting-user'
}

export type IssueSeverity = 'blocker' | 'major' | 'minor' | 'nit'
export type VerifyOutcome = 'verified' | 'still-broken' | 'needs-discussion'
export type ReviewIssueStatus = 'open' | 'fixed' | 'wontfix' | 'needs-check'

/** 人工设置的 issue 状态。key = `${roundId}:${issueId}`(见 issueStatusKey)。 */
export interface IssueStatusOverride {
  status: ReviewIssueStatus
  note?: string
  updatedAt: string
}

export function issueStatusKey(roundId: string, issueId: string): string {
  return `${roundId}:${issueId}`
}

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
  /** Agent workflow prompt language captured when the room is created. */
  promptLocale?: 'en' | 'zh-CN'
  phase: ReviewPhase
  participants: AgentName[]
  rounds: ReviewRound[]
  issueSets: ReviewIssueSet[]
  freshReviews: FreshReviewLink[]
  /**
   * 人工设置的 issue 状态,**与 issueSets 分开存**。
   * issueSets 会被 saveIssueSet 整体替换(重新抽取 / force extract),状态放在里面会被覆盖;
   * issue id 由 extract-issues 按 `${agent}-${序号}` 确定性生成,同一轮重抽结果一致,
   * 所以按 key 存的人工状态能跨重抽存活。
   */
  statusOverrides?: Record<string, IssueStatusOverride>
  /** Done 收口时用户写下的最终决策 / 后续任务(自由文本)。 */
  conclusion?: string
  doneAt?: string
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
  await groupThreadStore.writeSummary(state.groupThreadId, renderReviewRoomSummary(state))
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
    promptLocale?: 'en' | 'zh-CN'
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
        promptLocale: input.promptLocale,
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

  /** 用户取消当前 Review Room 工作时，立即持久化轮次终态；agent 的异步收尾可随后幂等回写。 */
  async abortRunningRounds(groupThreadId: string): Promise<ReviewRoomDiskState | null> {
    return enqueue(groupThreadId, async () => {
      const current = await this.read(groupThreadId)
      if (!current) return null
      if (!current.rounds.some((round) => round.status === 'running')) return current
      const now = new Date().toISOString()
      const next: ReviewRoomDiskState = {
        ...current,
        rounds: current.rounds.map((round) =>
          round.status === 'running' ? { ...round, status: 'aborted', completedAt: now } : round,
        ),
        updatedAt: now,
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
        // 已 done 的房间不因为重新抽取而被悄悄改回 compare —— 收口是用户的显式决定。
        phase:
          current.phase !== 'done' && current.rounds.find((r) => r.id === roundId)?.kind === 'review'
            ? 'compare'
            : current.phase,
        issueSets: [...filtered, set],
        updatedAt: now,
      }
      await writeState(next)
      return next
    })
  },

  /** 设置(status 非 null)或清除(status === null)某条 issue 的人工状态。 */
  async setIssueStatus(
    groupThreadId: string,
    roundId: string,
    issueId: string,
    status: ReviewIssueStatus | null,
    note?: string,
  ): Promise<ReviewRoomDiskState | null> {
    return enqueue(groupThreadId, async () => {
      const current = await this.read(groupThreadId)
      if (!current) return null
      const key = issueStatusKey(roundId, issueId)
      const overrides = { ...(current.statusOverrides ?? {}) }
      if (status === null) delete overrides[key]
      else overrides[key] = { status, ...(note ? { note } : {}), updatedAt: new Date().toISOString() }
      const next: ReviewRoomDiskState = {
        ...current,
        statusOverrides: overrides,
        updatedAt: new Date().toISOString(),
      }
      await writeState(next)
      return next
    })
  },

  /** Done 收口 / 重新打开。收口只改 phase 与 conclusion,不动 rounds 和 issueSets。 */
  async setDone(
    groupThreadId: string,
    done: boolean,
    conclusion?: string,
  ): Promise<ReviewRoomDiskState | null> {
    return enqueue(groupThreadId, async () => {
      const current = await this.read(groupThreadId)
      if (!current) return null
      const now = new Date().toISOString()
      const next: ReviewRoomDiskState = {
        ...current,
        // 重新打开时回到 compare(已有 findings 可继续处理);没有任何轮次则回 draft。
        phase: done ? 'done' : current.rounds.length ? 'compare' : 'draft',
        ...(conclusion !== undefined ? { conclusion } : {}),
        ...(done ? { doneAt: now } : { doneAt: undefined }),
        updatedAt: now,
      }
      await writeState(next)
      return next
    })
  },

  /** docs/14 §Fix:标记为手动修复中(phase=fix),不启动任何 agent run。 */
  async startManualFix(groupThreadId: string): Promise<ReviewRoomDiskState | null> {
    return enqueue(groupThreadId, async () => {
      const current = await this.read(groupThreadId)
      if (!current) return null
      // 已经在等用户时不重复插入轮次。
      if (current.rounds.some((r) => r.status === 'awaiting-user')) return current
      const now = new Date().toISOString()
      const next: ReviewRoomDiskState = {
        ...current,
        phase: 'fix',
        rounds: [
          ...current.rounds,
          { id: randomUUID(), kind: 'fix', mode: 'manual', agents: [], startedAt: now, status: 'awaiting-user' },
        ],
        updatedAt: now,
      }
      await writeState(next)
      return next
    })
  },

  /** 关闭挂起的手动修复轮(用户点「我修好了,去复核」时调用)。 */
  async closeManualFix(groupThreadId: string): Promise<ReviewRoomDiskState | null> {
    return enqueue(groupThreadId, async () => {
      const current = await this.read(groupThreadId)
      if (!current) return null
      if (!current.rounds.some((r) => r.status === 'awaiting-user')) return current
      const now = new Date().toISOString()
      const next: ReviewRoomDiskState = {
        ...current,
        rounds: current.rounds.map((r) =>
          r.status === 'awaiting-user' ? { ...r, status: 'completed' as const, completedAt: now } : r,
        ),
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
