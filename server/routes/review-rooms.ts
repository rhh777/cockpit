import fsp from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AgentName, Source } from '../loaders/types'
import { groupThreadStore } from '../store/group-thread-store'
import { reviewRoomStore, type ReviewRoomPathSource, type ReviewRoomSource } from '../store/review-room-store'
import { extractIssuesForRound } from '../review/extract-issues'
import { planReviewRound, RoundPlanError, type RoundKind } from '../review/round-plan'
import {
  collectOutcomeTrail,
  resolveIssueStatus,
  summarizeIssueStatuses,
} from '../review/issue-status'
import { computeSourceFreshness, makeFreshnessProbe } from '../review/source-freshness'
import { deriveFreshReviewResult, rollupFreshReviews } from '../review/fresh-review-link'
import type { ReviewIssueStatus, ReviewRoomDiskState } from '../store/review-room-store'
import { randomUUID } from 'node:crypto'
import { handoffDir, handoffStore } from '../store/handoff-store'
import { buildContext } from '../handoffs/context-builder'
import type { HandoffSourceRef } from '../handoffs/types'
import { sessionRegistry } from '../registry/session-registry'
import { loadSessionDetail } from '../sessions-service'
import { normalizeRunPermissions } from '../permissions/types'
import { runRegistry } from '../runs/run-registry'
import { isUserWorkspacePath, isValidSessionId, isValidSessionIdForSource, isValidSource } from '../util/security'
import { cleanTitle } from '../util/title'

const execFileAsync = promisify(execFile)
const DEFAULT_REVIEW_AGENTS = ['claude', 'codex'] as AgentName[]

const freshnessProbe = makeFreshnessProbe({
  resolveNativeSession: (source, sessionId) => sessionRegistry.resolve(source as Source, sessionId),
  readGroupThread: async (id) => {
    const state = await groupThreadStore.readState(id)
    if (!state) return null
    const transcript = await groupThreadStore.readTranscript(id)
    return { eventCount: transcript.length, summaryRevision: state.summaryRevision }
  },
})

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

function uniqueAgents(value: unknown): AgentName[] {
  if (!Array.isArray(value)) return [...DEFAULT_REVIEW_AGENTS]
  const agents = value.filter((v): v is AgentName => typeof v === 'string' && v.length > 0)
  return agents.length ? [...new Set(agents)] : [...DEFAULT_REVIEW_AGENTS]
}

type BuiltSource = { source: ReviewRoomSource; title: string; cwd: string | null; snapshotText: string }

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '\n… [truncated]'
}

function textOfEvent(env: { event: { type: string; text?: string; agent?: string; targetAgent?: string } }): string | null {
  const e = env.event
  if (e.type === 'user_text' && typeof e.text === 'string') {
    const target = e.targetAgent ? ` → ${e.targetAgent}` : ''
    return `[user${target}] ${e.text}`
  }
  if (e.type === 'assistant_text' && typeof e.text === 'string') {
    return `[${e.agent ?? 'assistant'}] ${e.text}`
  }
  return null
}

async function pathSource(input: unknown): Promise<BuiltSource> {
  const o = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const kind = o.kind === 'repository' || o.kind === 'directory' || o.kind === 'files' || o.kind === 'document'
    ? o.kind as 'repository' | 'directory' | 'files' | 'document'
    : null
  if (!kind) throw new Error('unsupported path source')
  const rawPaths = Array.isArray(o.paths) ? o.paths : typeof o.path === 'string' ? [o.path] : []
  const paths = rawPaths.filter((p): p is string => typeof p === 'string' && path.isAbsolute(p))
  if (paths.length === 0) throw new Error('absolute path required')
  for (const p of paths) {
    if (!isUserWorkspacePath(p)) throw new Error(`path not allowed (must be under HOME, outside sensitive dot dirs): ${p}`)
  }

  const refs: ReviewRoomPathSource[] = []
  // files / document 记逐文件 mtime 作为 stale 检测基线(docs/14 §上下文来源)。
  const pathMtimes: { path: string; mtimeMs: number }[] = []
  for (const p of paths.slice(0, 20)) {
    const st = await fsp.stat(p).catch(() => null)
    if (!st) throw new Error(`path does not exist: ${p}`)
    if (kind === 'repository' || kind === 'directory') {
      if (!st.isDirectory()) throw new Error(`directory required: ${p}`)
    } else if (!st.isFile()) {
      throw new Error(`file required: ${p}`)
    } else {
      pathMtimes.push({ path: p, mtimeMs: st.mtimeMs })
    }
    refs.push({
      kind: kind === 'files' ? 'file' : kind,
      path: p,
      name: path.basename(p) || p,
    })
  }

  const cwd = kind === 'repository' || kind === 'directory'
    ? refs[0]?.path ?? null
    : refs[0] ? path.dirname(refs[0].path) : null
  const title = typeof o.title === 'string' && o.title.trim()
    ? o.title.trim()
    : `${kind === 'repository' ? 'Repository' : kind === 'directory' ? 'Folder' : kind === 'document' ? 'Document' : 'Files'} Review: ${refs[0]?.name ?? 'Review Room'}`
  const gitHead = cwd ? await readGitHead(cwd) : undefined
  const snapshotText = await buildPathSnapshot(refs, cwd, gitHead)
  return {
    title,
    cwd,
    snapshotText,
    source: {
      kind,
      title,
      cwd,
      paths: refs,
      snapshotCreatedAt: new Date().toISOString(),
      sourceSnapshot:
        gitHead || pathMtimes.length
          ? { ...(gitHead ? { gitHead } : {}), ...(pathMtimes.length ? { pathMtimes } : {}) }
          : undefined,
    },
  }
}

async function buildPathSnapshot(refs: ReviewRoomPathSource[], cwd: string | null, gitHead: string | undefined): Promise<string> {
  const lines: string[] = []
  if (cwd) lines.push(`cwd: ${cwd}`)
  if (gitHead) lines.push(`git HEAD: ${gitHead}`)
  for (const ref of refs) {
    lines.push('', `--- ${ref.kind}: ${ref.path}`)
    if (ref.kind === 'file' || ref.kind === 'document') {
      const body = await fsp.readFile(ref.path, 'utf8').catch((e) => `[read failed: ${String((e as Error)?.message ?? e)}]`)
      lines.push(truncate(body, 8000))
    } else {
      const entries = await fsp.readdir(ref.path, { withFileTypes: true }).catch(() => [])
      const rows = entries
        .slice(0, 200)
        .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
        .sort()
      lines.push(rows.length ? rows.join('\n') : '[empty]')
    }
  }
  return truncate(lines.join('\n'), 16000)
}

async function sessionSource(input: unknown): Promise<BuiltSource> {
  const o = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const kind = o.kind === 'native-session' || o.kind === 'cockpit-followup' || o.kind === 'group-thread' ? o.kind : null
  if (!kind) throw new Error('unsupported session source')
  if (kind === 'group-thread') {
    const groupThreadId = typeof o.groupThreadId === 'string' ? o.groupThreadId : typeof o.sessionId === 'string' ? o.sessionId : ''
    if (!isValidSessionId(groupThreadId)) throw new Error('invalid groupThreadId')
    const state = await groupThreadStore.readState(groupThreadId)
    if (!state) throw new Error('group thread not found')
    const transcript = await groupThreadStore.readTranscript(groupThreadId)
    const summary = await groupThreadStore.readSummary(groupThreadId).catch(() => '')
    const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : state.title
    const snapshotText = buildTranscriptSnapshot(title, state.cwd, summary, transcript)
    return {
      title,
      cwd: state.cwd,
      snapshotText,
      source: {
        kind,
        title,
        cwd: state.cwd,
        groupThreadId,
        snapshotCreatedAt: new Date().toISOString(),
        sourceSnapshot: { eventCount: transcript.length, summaryRevision: state.summaryRevision },
      },
    }
  }

  const source = typeof o.source === 'string' ? o.source as Source : ''
  const sessionId = typeof o.sessionId === 'string' ? o.sessionId : ''
  if (!isValidSource(source) || !isValidSessionIdForSource(source, sessionId)) throw new Error('invalid source session')
  const filePath = await sessionRegistry.resolve(source, sessionId)
  if (!filePath) throw new Error('source session not found')
  const detail = await loadSessionDetail(source, sessionId, filePath)
  if (!detail) throw new Error('source session load failed')
  const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : detail.summary.title
  const snapshotText = buildTranscriptSnapshot(title, detail.summary.cwd, '', detail.events as unknown as { event: { type: string; text?: string; agent?: string; targetAgent?: string } }[])
  return {
    title,
    cwd: detail.summary.cwd,
    snapshotText,
    source: {
      kind,
      title,
      cwd: detail.summary.cwd,
      nativeSession: { source, sessionId },
      snapshotCreatedAt: new Date().toISOString(),
      sourceSnapshot: {
        eventCount: detail.events.length,
        fileMtimeMs: detail.summary.fileMtimeMs,
      },
    },
  }
}

function buildTranscriptSnapshot(
  title: string,
  cwd: string | null,
  summary: string,
  events: { event: { type: string; text?: string; agent?: string; targetAgent?: string } }[],
): string {
  const parts: string[] = [`title: ${title}`]
  if (cwd) parts.push(`cwd: ${cwd}`)
  if (summary.trim()) {
    parts.push('', '--- shared summary', truncate(summary.trim(), 4000))
  }
  const texts: string[] = []
  for (let i = events.length - 1; i >= 0 && texts.length < 30; i--) {
    const line = textOfEvent(events[i])
    if (line) texts.unshift(line)
  }
  if (texts.length) {
    parts.push('', `--- recent transcript (last ${texts.length} text events)`, truncate(texts.join('\n\n'), 10000))
  }
  return truncate(parts.join('\n'), 16000)
}

function freeformSource(input: unknown, goal: string): BuiltSource {
  const o = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const text = typeof o.freeformText === 'string' ? o.freeformText : ''
  const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : cleanTitle(goal || text, 48) || 'Review Room'
  return {
    title,
    cwd: null,
    snapshotText: truncate(text, 12000),
    source: {
      kind: 'freeform',
      title,
      cwd: null,
      freeformText: text,
      snapshotCreatedAt: new Date().toISOString(),
    },
  }
}

async function readGitHead(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { timeout: 2000 })
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}

async function buildSource(input: unknown, goal: string) {
  const o = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  if (o.kind === 'native-session' || o.kind === 'cockpit-followup' || o.kind === 'group-thread') return sessionSource(input)
  if (o.kind === 'repository' || o.kind === 'directory' || o.kind === 'files' || o.kind === 'document') return pathSource(input)
  return freeformSource(input, goal)
}

async function handleCreate(req: IncomingMessage, res: ServerResponse) {
  const body = (await readBody(req)) as {
    source?: unknown
    goal?: string
    preset?: string
    participants?: AgentName[]
    mode?: 'parallel' | 'serial'
    startReview?: boolean
    permissions?: unknown
  }
  const goal = (body.goal ?? '').trim()
  const participants = uniqueAgents(body.participants)
  let built: Awaited<ReturnType<typeof buildSource>>
  try {
    built = await buildSource(body.source, goal)
  } catch (e) {
    sendJson(res, 400, { error: String((e as Error)?.message ?? e) })
    return
  }

  const title = cleanTitle(built.title, 60) || 'Review Room'
  const group = await groupThreadStore.create({
    title,
    cwd: built.cwd,
    agents: participants,
    extensions: {
      reviewRoom: {
        enabled: true,
        sourceKind: built.source.kind,
      },
    },
  })
  const review = await reviewRoomStore.create({
    groupThreadId: group.id,
    source: built.source,
    goal,
    preset: body.preset ?? null,
    participants,
  })

  await groupThreadStore.appendEvent(group.id, {
    origin: 'cockpit',
    source: 'cockpit',
    sourceEventId: `review-room:init:${group.id}`,
    event: {
      type: 'meta',
      key: 'review_room_created',
      value: {
        reviewRoomId: group.id,
        source: built.source,
        goal,
        preset: body.preset ?? null,
        participants,
        snapshotText: built.snapshotText,
      },
      ts: new Date().toISOString(),
    },
  })

  let started: unknown = null
  let startError: string | null = null
  if (body.startReview === true) {
    try {
      started = await startReviewRound(group.id, body.mode === 'serial' ? 'serial' : 'parallel', body.permissions)
    } catch (e) {
      startError = String((e as Error)?.message ?? e)
    }
  }

  sessionRegistry.invalidate()
  sendJson(res, 201, {
    reviewRoomId: group.id,
    groupThreadId: group.id,
    state: group,
    review,
    started,
    ...(startError ? { startError } : {}),
  })
}

async function startReviewRound(
  id: string,
  mode: 'parallel' | 'serial',
  permissions?: unknown,
  kind: RoundKind = 'review',
  participantsOverride?: AgentName[],
) {
  const group = await groupThreadStore.readState(id)
  const review = await reviewRoomStore.read(id)
  if (!group || !review) throw new Error('review room not found')
  const plan = planReviewRound({
    kind,
    mode,
    participantsOverride,
    review,
    groupAgents: group.agents,
  })
  const { participants, runMode } = plan
  const snapshotText = await recoverSnapshotText(id)
  const priorFindings = kind !== 'review' ? formatPriorFindings(review) : ''
  const started = await runRegistry.startGroupTurn({
    id,
    text: reviewPrompt(review.source, review.goal, snapshotText, kind, priorFindings),
    targetAgents: runMode === 'serial' ? [participants[0]] : participants,
    mode: runMode,
    serial: runMode === 'serial'
      ? {
          participants,
          firstAgent: participants[0],
          maxSteps: 6,
          stopOnConsensus: true,
          preset: kind === 'review' ? 'architecture-first' : 'implementation-first',
        }
      : undefined,
    useTools: kind !== 'review',
    permissions: normalizeRunPermissions(permissions),
  })
  await reviewRoomStore.startRound(id, {
    kind,
    mode: plan.roundMode,
    agents: participants,
    groupTurnId: started.groupTurnId,
  })
  // 「我修好了,去复核」:verify 轮**成功起来之后**才收掉挂起的手动修复轮。
  // 放在启动前的话,一旦 plan 校验失败或 run 起不来,用户就白丢了「手动修复中」标记。
  if (kind === 'verify') await reviewRoomStore.closeManualFix(id)
  sessionRegistry.invalidate()
  return started
}

async function recoverSnapshotText(groupThreadId: string): Promise<string> {
  const transcript = await groupThreadStore.readTranscript(groupThreadId).catch(() => [])
  for (const env of transcript) {
    const e = env.event
    if (e.type === 'meta' && e.key === 'review_room_created') {
      const value = e.value as { snapshotText?: unknown } | undefined
      if (typeof value?.snapshotText === 'string') return value.snapshotText
    }
  }
  return ''
}

function formatPriorFindings(review: import('../store/review-room-store').ReviewRoomDiskState): string {
  const lastReviewRound = [...review.rounds].reverse().find((r) => r.kind === 'review' && r.status === 'completed')
  if (!lastReviewRound) return ''
  const set = review.issueSets.find((s) => s.roundId === lastReviewRound.id)
  if (!set || set.issues.length === 0) return ''
  const lines: string[] = ['', 'Prior review findings (reference by issueId in your results):']
  for (const it of set.issues) {
    const at = it.path ? ` @ ${it.path}${it.line ? `:${it.line}` : ''}` : ''
    lines.push(`- [${it.id}] (${it.severity}) ${it.title}${at} — ${it.agent}`)
    if (it.body) lines.push(`    ${it.body.split('\n').join(' ').slice(0, 240)}`)
  }
  return lines.join('\n')
}

function reviewPrompt(
  source: ReviewRoomSource,
  goal: string,
  snapshotText: string,
  kind: RoundKind,
  priorFindings: string,
): string {
  const sourceLine = source.paths?.length
    ? source.paths.map((p) => `${p.kind}: ${p.path}`).join('\n')
    : source.nativeSession
      ? `${source.nativeSession.source}:${source.nativeSession.sessionId}`
      : source.groupThreadId
        ? `group-thread:${source.groupThreadId}`
        : source.freeformText ?? ''
  const intro = kind === 'review'
    ? 'You are one of multiple reviewers looking at this Review Room source independently.'
    : kind === 'fix'
      ? 'You are addressing the issues surfaced in the earlier review round. Apply the smallest change that resolves each concern.'
      : 'You are verifying the fixes applied in the previous round. Confirm each issue is resolved or flag remaining gaps.'
  const tail = kind === 'review'
    ? 'Write your analysis in prose first, then close the message with the FINDINGS block below. Do not modify files during review.'
    : kind === 'fix'
      ? 'Describe your changes in prose, then close with a FINDINGS block enumerating fixed/deferred issues.'
      : 'Walk through each earlier issue, then close with a FINDINGS block giving VERIFIED / STILL BROKEN / NEEDS DISCUSSION for each.'
  const findingsSpec = kind === 'review'
    ? [
        '',
        'IMPORTANT — end your message with a structured findings block so the Review Room can compare reviewers:',
        '',
        'FINDINGS',
        '```json',
        '{',
        '  "issues": [',
        '    {"title": "short problem statement", "severity": "blocker|major|minor|nit", "path": "src/foo.ts", "line": 42, "body": "why it matters and how to fix"}',
        '  ],',
        '  "agreements": ["points you likely agree with the other reviewer on"],',
        '  "disagreements": ["points you expect the other reviewer to disagree on"],',
        '  "next": "recommended next step (fix / verify / discuss / stop)"',
        '}',
        '```',
        '',
        'Use empty arrays if not applicable. Do not add extra prose after the closing fence.',
      ].join('\n')
    : [
        '',
        'IMPORTANT — end your message with a structured results block. Reference prior issue ids in refIssueId:',
        '',
        'FINDINGS',
        '```json',
        '{',
        '  "results": [',
        kind === 'fix'
          ? '    {"refIssueId": "claude-1", "outcome": "verified|still-broken|needs-discussion", "path": "src/foo.ts", "note": "what changed and where"}'
          : '    {"refIssueId": "claude-1", "outcome": "verified|still-broken|needs-discussion", "note": "evidence checked"}',
        '  ],',
        '  "issues": [',
        '    {"title": "any new issue discovered while working", "severity": "major", "body": "..."}',
        '  ],',
        '  "next": "fix|verify|discuss|stop"',
        '}',
        '```',
        '',
        'Use empty arrays when nothing applies. Do not add extra prose after the closing fence.',
      ].join('\n')
  return [
    intro,
    goal ? `Goal: ${goal}` : '',
    '',
    `Source (${source.kind}):`,
    sourceLine,
    snapshotText ? '\nSnapshot at review-room creation time:\n---\n' + snapshotText + '\n---' : '',
    priorFindings,
    '',
    tail,
    findingsSpec,
  ].filter(Boolean).join('\n')
}

// 下发给前端的 review DTO:每条 issue 附上解析后的 status / statusSource,
// 并带一份最近一轮 review 的状态汇总。优先级规则只在服务端实现一次(docs/14)。
async function decorateReview(review: ReviewRoomDiskState) {
  const outcomeTrail = collectOutcomeTrail(review.rounds, review.issueSets)
  // source 新鲜度:只读判断,永不回写 snapshot(docs/14 §上下文来源)。失败降级为 unknown。
  const sourceFreshness = await computeSourceFreshness(review.source, freshnessProbe).catch(
    () => ({ status: 'unknown' as const, reason: 'not-resolvable' as const }),
  )
  // Fresh review 回链:从各 child 的 review-state 派生只读视图,不写进 parent 的 issueSets。
  // 先对 child 做一次 reconcile —— child 的 findings 是在它自己被 GET 时才抽取的,
  // 但用户可能只看 parent 从没打开过 child,那样回链会永远停在「进行中」。
  // reconcile 幂等,没变化时不写盘。
  const freshResults = await Promise.all(
    (review.freshReviews ?? []).map(async (link) => {
      const raw = await reviewRoomStore.read(link.childReviewRoomId).catch(() => null)
      const child = raw
        ? await reconcileRoundsAndIssues(link.childReviewRoomId, raw).catch(() => raw)
        : null
      return deriveFreshReviewResult(link, child ?? raw)
    }),
  )
  const freshReviewRollup = rollupFreshReviews(freshResults)
  return {
    sourceFreshness,
    freshReviewRollup,
    ...review,
    issueSets: review.issueSets.map((set) => ({
      ...set,
      issues: set.issues.map((issue) => {
        const resolved = resolveIssueStatus({
          roundId: set.roundId,
          issue,
          overrides: review.statusOverrides,
          outcomeTrail,
        })
        return { ...issue, status: resolved.status, statusSource: resolved.source }
      }),
    })),
    statusSummary: summarizeIssueStatuses(review.rounds, review.issueSets, review.statusOverrides),
  }
}

const ISSUE_STATUSES: ReviewIssueStatus[] = ['open', 'fixed', 'wontfix', 'needs-check']

async function handleSetIssueStatus(req: IncomingMessage, res: ServerResponse, id: string) {
  if (!isValidSessionId(id)) {
    sendJson(res, 400, { error: 'invalid reviewRoomId' })
    return
  }
  const body = (await readBody(req)) as { roundId?: string; issueId?: string; status?: string | null; note?: string }
  const roundId = typeof body.roundId === 'string' ? body.roundId : ''
  const issueId = typeof body.issueId === 'string' ? body.issueId : ''
  if (!roundId || !issueId) {
    sendJson(res, 400, { error: 'roundId and issueId are required' })
    return
  }
  // status === null 表示清除人工状态,回落到派生/默认。
  const status =
    body.status === null || body.status === undefined
      ? null
      : (ISSUE_STATUSES as string[]).includes(body.status)
        ? (body.status as ReviewIssueStatus)
        : undefined
  if (status === undefined) {
    sendJson(res, 400, { error: `status must be one of ${ISSUE_STATUSES.join(' | ')} or null` })
    return
  }
  const review = await reviewRoomStore.read(id)
  if (!review) {
    sendJson(res, 404, { error: 'review room not found' })
    return
  }
  if (!review.rounds.some((r) => r.id === roundId)) {
    sendJson(res, 404, { error: 'round not found' })
    return
  }
  const next = await reviewRoomStore.setIssueStatus(id, roundId, issueId, status, body.note)
  if (!next) {
    sendJson(res, 404, { error: 'review room not found' })
    return
  }
  sendJson(res, 200, { reviewRoomId: id, review: await decorateReview(next) })
}

// docs/14 §Fix「I'll fix manually」:只标记状态,不启动任何 agent run。
async function handleManualFix(req: IncomingMessage, res: ServerResponse, id: string) {
  if (!isValidSessionId(id)) {
    sendJson(res, 400, { error: 'invalid reviewRoomId' })
    return
  }
  const body = (await readBody(req)) as { active?: boolean }
  const review = await reviewRoomStore.read(id)
  if (!review) {
    sendJson(res, 404, { error: 'review room not found' })
    return
  }
  // active:false = 放弃手动修复(不进 verify),把挂起的轮次收掉。
  const next =
    body.active === false
      ? await reviewRoomStore.closeManualFix(id)
      : await reviewRoomStore.startManualFix(id)
  if (!next) {
    sendJson(res, 404, { error: 'review room not found' })
    return
  }
  sessionRegistry.invalidate()
  sendJson(res, 200, { reviewRoomId: id, review: await decorateReview(next) })
}

async function handleDone(req: IncomingMessage, res: ServerResponse, id: string) {
  if (!isValidSessionId(id)) {
    sendJson(res, 400, { error: 'invalid reviewRoomId' })
    return
  }
  const body = (await readBody(req)) as { done?: boolean; conclusion?: string }
  const done = body.done !== false
  const review = await reviewRoomStore.read(id)
  if (!review) {
    sendJson(res, 404, { error: 'review room not found' })
    return
  }
  // awaiting-user 是「在等用户动手」,不是 agent 正在跑,不该挡住收口。
  if (done && review.rounds.some((r) => r.status === 'running')) {
    sendJson(res, 409, { error: 'cannot finish while a round is still running' })
    return
  }
  const next = await reviewRoomStore.setDone(
    id,
    done,
    typeof body.conclusion === 'string' ? body.conclusion.trim() : undefined,
  )
  if (!next) {
    sendJson(res, 404, { error: 'review room not found' })
    return
  }
  sessionRegistry.invalidate()
  sendJson(res, 200, { reviewRoomId: id, review: await decorateReview(next) })
}

async function handleGet(res: ServerResponse, id: string) {
  if (!isValidSessionId(id)) {
    sendJson(res, 400, { error: 'invalid reviewRoomId' })
    return
  }
  const state = await groupThreadStore.readState(id)
  let review: ReviewRoomDiskState | null
  try {
    review = await reviewRoomStore.read(id)
  } catch (err) {
    if (!state) {
      sendJson(res, 404, { error: 'review room not found' })
      return
    }
    sendJson(res, 200, {
      reviewRoomId: id,
      groupThreadId: id,
      state,
      review: null,
      warning: {
        code: 'corrupt_review_state',
        message: String((err as Error)?.message ?? err),
      },
    })
    return
  }
  if (!state || !review) {
    sendJson(res, 404, { error: 'review room not found' })
    return
  }
  review = (await reconcileRoundsAndIssues(id, review)) ?? review
  sendJson(res, 200, { reviewRoomId: id, groupThreadId: id, state, review: await decorateReview(review) })
}

async function handleFreshReview(req: IncomingMessage, res: ServerResponse, id: string) {
  if (!isValidSessionId(id)) {
    sendJson(res, 400, { error: 'invalid reviewRoomId' })
    return
  }
  const body = (await readBody(req)) as {
    reviewerAgents?: AgentName[]
    reason?: 'verify' | 'new-risks' | 'user-requested'
    mode?: 'parallel' | 'serial'
    permissions?: unknown
    goal?: string
  }
  const parentState = await groupThreadStore.readState(id)
  const parent = await reviewRoomStore.read(id)
  if (!parentState || !parent) {
    sendJson(res, 404, { error: 'review room not found' })
    return
  }
  const reviewers = uniqueAgents(body.reviewerAgents)
  const reason = body.reason === 'new-risks' || body.reason === 'verify' ? body.reason : 'user-requested'
  const goal = (body.goal ?? `Fresh review of ${parent.source.title}. Do not be biased by prior findings — form your own judgement first, then compare.`).trim()

  const handoff = await tryBuildHandoffForFresh(id, parent)
  const snapshotText = buildFreshReviewSnapshot(parent, handoff)
  const childTitle = cleanTitle(`Fresh review · ${parent.source.title}`, 60) || 'Fresh Review'
  const childSource: ReviewRoomSource = {
    kind: 'freeform',
    title: childTitle,
    cwd: parent.source.cwd,
    freeformText: snapshotText,
    snapshotCreatedAt: new Date().toISOString(),
  }
  const child = await groupThreadStore.create({
    title: childTitle,
    cwd: parent.source.cwd,
    agents: reviewers,
    extensions: {
      reviewRoom: {
        enabled: true,
        sourceKind: 'freeform',
        parentReviewRoomId: id,
      },
    },
  })
  const childReview = await reviewRoomStore.create({
    groupThreadId: child.id,
    source: childSource,
    goal,
    participants: reviewers,
  })
  await groupThreadStore.appendEvent(child.id, {
    origin: 'cockpit',
    source: 'cockpit',
    sourceEventId: `review-room:init:${child.id}`,
    event: {
      type: 'meta',
      key: 'review_room_created',
      value: {
        reviewRoomId: child.id,
        source: childSource,
        goal,
        participants: reviewers,
        snapshotText,
        parentReviewRoomId: id,
        reason,
      },
      ts: new Date().toISOString(),
    },
  })
  await reviewRoomStore.linkFreshReview(id, {
    childReviewRoomId: child.id,
    reviewerAgents: reviewers,
    reason,
    ...(handoff ? { handoffId: handoff.id } : {}),
  })

  let started: unknown = null
  let startError: string | null = null
  try {
    started = await startReviewRound(child.id, body.mode === 'serial' ? 'serial' : 'parallel', body.permissions)
  } catch (e) {
    startError = String((e as Error)?.message ?? e)
  }
  sessionRegistry.invalidate()
  sendJson(res, 201, {
    parentReviewRoomId: id,
    childReviewRoomId: child.id,
    groupThreadId: child.id,
    review: await decorateReview(childReview),
    started,
    ...(startError ? { startError } : {}),
  })
}

function handoffSourceRefFrom(parent: import('../store/review-room-store').ReviewRoomDiskState): HandoffSourceRef | null {
  if (parent.source.groupThreadId) {
    return { kind: 'group-thread', groupThreadId: parent.source.groupThreadId }
  }
  if (parent.source.nativeSession) {
    return { kind: 'native-session', source: parent.source.nativeSession.source, sessionId: parent.source.nativeSession.sessionId }
  }
  return null
}

async function tryBuildHandoffForFresh(
  parentGroupThreadId: string,
  parent: import('../store/review-room-store').ReviewRoomDiskState,
): Promise<{ id: string; entryClaude: string; entryCodex: string; summaryPath: string } | null> {
  const ref = handoffSourceRefFrom(parent) ?? { kind: 'group-thread' as const, groupThreadId: parentGroupThreadId }
  const id = randomUUID()
  try {
    const context = await buildContext(
      { source: ref, target: 'both' },
      { handoffDir: handoffDir(id) },
    )
    const manifest = await handoffStore.create({ id, sourceRef: ref, context, inheritedTarget: 'both' })
    return {
      id: manifest.handoffId,
      entryClaude: manifest.files.entries.claude,
      entryCodex: manifest.files.entries.codex,
      summaryPath: manifest.files.canonical.summary,
    }
  } catch {
    // Fallback:某些 source kind(freeform/path)无法建 handoff,回落纯 inline snapshot。
    return null
  }
}

function buildFreshReviewSnapshot(
  parent: import('../store/review-room-store').ReviewRoomDiskState,
  handoff: { id: string; entryClaude: string; entryCodex: string; summaryPath: string } | null = null,
): string {
  const parts: string[] = [
    `Parent Review Room: ${parent.source.title}`,
    `Original goal: ${parent.goal || '(none)'}`,
    `Source kind: ${parent.source.kind}`,
  ]
  if (parent.source.cwd) parts.push(`cwd: ${parent.source.cwd}`)
  if (parent.source.paths?.length) {
    parts.push('paths:')
    for (const p of parent.source.paths) parts.push(`  ${p.kind}: ${p.path}`)
  }
  if (parent.source.nativeSession) {
    parts.push(`native session: ${parent.source.nativeSession.source}:${parent.source.nativeSession.sessionId}`)
  }
  if (handoff) {
    parts.push('')
    parts.push('Handoff bundle available (read the entry file that matches you):')
    parts.push(`  claude entry: ${handoff.entryClaude}`)
    parts.push(`  codex entry:  ${handoff.entryCodex}`)
    parts.push(`  summary:      ${handoff.summaryPath}`)
    parts.push(`  handoff id:   ${handoff.id}`)
  }
  const lastReview = [...parent.rounds].reverse().find((r) => r.kind === 'review' && r.status === 'completed')
  const set = lastReview ? parent.issueSets.find((s) => s.roundId === lastReview.id) : undefined
  if (set) {
    parts.push('', 'Prior compare findings (do NOT anchor on these — form independent judgement first):')
    for (const it of set.issues) {
      const at = it.path ? ` @ ${it.path}${it.line ? `:${it.line}` : ''}` : ''
      parts.push(`- [${it.id}] (${it.severity}) ${it.title}${at} — ${it.agent}`)
    }
    if (set.agreements.length) parts.push('', `Prior agreements: ${set.agreements.join('; ')}`)
    if (set.disagreements.length) parts.push(`Prior disagreements: ${set.disagreements.join('; ')}`)
    if (set.recommendedNextStep) parts.push(`Prior recommended next: ${set.recommendedNextStep}`)
  } else {
    parts.push('', 'No prior findings available yet.')
  }
  return parts.join('\n')
}

async function handleExtract(req: IncomingMessage, res: ServerResponse, id: string) {
  if (!isValidSessionId(id)) {
    sendJson(res, 400, { error: 'invalid reviewRoomId' })
    return
  }
  const body = (await readBody(req)) as { roundId?: string; force?: boolean }
  const review = await reviewRoomStore.read(id)
  if (!review) {
    sendJson(res, 404, { error: 'review room not found' })
    return
  }
  const transcript = await groupThreadStore.readTranscript(id)
  const targetIds = body.roundId
    ? review.rounds.filter((r) => r.id === body.roundId).map((r) => r.id)
    : review.rounds.map((r) => r.id)
  let next = review
  for (const rId of targetIds) {
    const round = next.rounds.find((r) => r.id === rId)
    if (!round?.groupTurnId) continue
    if (!body.force && next.issueSets.some((s) => s.roundId === rId)) continue
    const parsed = extractIssuesForRound(transcript, round.groupTurnId)
    const saved = await reviewRoomStore.saveIssueSet(id, rId, parsed)
    if (saved) next = saved
  }
  sendJson(res, 200, { reviewRoomId: id, review: await decorateReview(next) })
}

// GET 时按 transcript 的 turn_status 补写轮次状态,并对已完成、还没 issueSet 的轮次做一次抽取。
async function reconcileRoundsAndIssues(id: string, review: import('../store/review-room-store').ReviewRoomDiskState) {
  const transcript = await groupThreadStore.readTranscript(id).catch(() => [])
  const statusByTurn = new Map<string, 'completed' | 'failed' | 'aborted'>()
  for (const env of transcript) {
    const e = env.event
    if (e.type !== 'meta' || e.key !== 'turn_status') continue
    const value = e.value as { groupTurnId?: string; status?: string; agent?: string } | undefined
    if (!value?.groupTurnId) continue
    // 一个 groupTurn 里可能多 agent → 多个 turn_status。若已见过 failed/aborted 则不覆盖为 completed。
    const cur = statusByTurn.get(value.groupTurnId)
    if (cur === 'failed' || cur === 'aborted') continue
    if (value.status === 'completed' || value.status === 'failed' || value.status === 'aborted') {
      statusByTurn.set(value.groupTurnId, value.status)
    }
  }
  let next = review
  for (const round of review.rounds) {
    if (!round.groupTurnId) continue
    const observed = statusByTurn.get(round.groupTurnId)
    if (observed && observed !== round.status) {
      const updated = await reviewRoomStore.completeRound(id, round.id, observed)
      if (updated) next = updated
    }
    const finalStatus = next.rounds.find((r) => r.id === round.id)?.status ?? round.status
    if (finalStatus === 'completed' && !next.issueSets.some((s) => s.roundId === round.id)) {
      const parsed = extractIssuesForRound(transcript, round.groupTurnId)
      if (parsed.issues.length > 0 || parsed.agreements.length > 0 || parsed.disagreements.length > 0) {
        const updated = await reviewRoomStore.saveIssueSet(id, round.id, parsed)
        if (updated) next = updated
      }
    }
  }
  return next
}

async function handleStartReview(req: IncomingMessage, res: ServerResponse, id: string) {
  if (!isValidSessionId(id)) {
    sendJson(res, 400, { error: 'invalid reviewRoomId' })
    return
  }
  const body = (await readBody(req)) as {
    mode?: 'parallel' | 'serial'
    permissions?: unknown
    kind?: RoundKind
    participants?: AgentName[]
  }
  const kind: RoundKind = body.kind === 'fix' || body.kind === 'verify' ? body.kind : 'review'
  try {
    const started = await startReviewRound(
      id,
      body.mode === 'serial' ? 'serial' : 'parallel',
      body.permissions,
      kind,
      Array.isArray(body.participants) ? body.participants : undefined,
    )
    sendJson(res, 202, started)
  } catch (e) {
    const message = String((e as Error)?.message ?? e)
    // 违反轮次约束(如 fix 传多个 fixer)是客户端错误,固定 400,不靠 message 猜。
    const status = e instanceof RoundPlanError
      ? 400
      : message.includes('already running')
        ? 409
        : message.includes('not found')
          ? 404
          : 400
    sendJson(res, status, { error: message })
  }
}

export async function handleReviewRoomsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts[1] !== 'review-rooms') return false

  if (req.method === 'POST' && parts.length === 2) {
    await handleCreate(req, res)
    return true
  }

  if (req.method === 'GET' && parts.length === 3) {
    await handleGet(res, decodeURIComponent(parts[2]))
    return true
  }

  if (req.method === 'POST' && parts.length === 4 && parts[3] === 'review') {
    await handleStartReview(req, res, decodeURIComponent(parts[2]))
    return true
  }

  if (req.method === 'POST' && parts.length === 4 && parts[3] === 'extract') {
    await handleExtract(req, res, decodeURIComponent(parts[2]))
    return true
  }

  if (req.method === 'POST' && parts.length === 4 && parts[3] === 'issue-status') {
    await handleSetIssueStatus(req, res, decodeURIComponent(parts[2]))
    return true
  }

  if (req.method === 'POST' && parts.length === 4 && parts[3] === 'manual-fix') {
    await handleManualFix(req, res, decodeURIComponent(parts[2]))
    return true
  }

  if (req.method === 'POST' && parts.length === 4 && parts[3] === 'done') {
    await handleDone(req, res, decodeURIComponent(parts[2]))
    return true
  }

  if (req.method === 'POST' && parts.length === 4 && parts[3] === 'fresh-review') {
    await handleFreshReview(req, res, decodeURIComponent(parts[2]))
    return true
  }

  return false
}
