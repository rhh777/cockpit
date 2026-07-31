import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  extractReviewIssues,
  fetchChanges,
  fetchReviewRoom,
  fetchRunningRuns,
  fetchSessionDetail,
  finishReviewRoom,
  revealSession,
  setManualFix,
  setReviewIssueStatus,
  startFreshReview,
  type ReviewRoomState,
  type SessionDetailDTO,
} from '../lib/api'
import { ReviewCompareView, SourceFreshnessBanner } from '../components/ReviewCompareView'
import {
  attachGroupTurnStream,
  attachRunStream,
  cancelGroupTurn,
  cancelRun,
  fetchActiveRuns,
  subscribeSessionStream,
  startFollowupRun,
  startGroupRun,
  startReviewRoomRun,
  startNativeResumeRun,
  type RunRecord,
  type RunStreamMessage,
} from '../lib/sse'
import { labelForAgent, sessionAgentOf } from '../lib/agents'
import { useI18n, type MessageKey } from '../lib/i18n'
import { sourceLabel, displayTitle } from '../lib/display'
import { buildTimeline, summarizeTools, type FilterKind, type TraceGroup } from '../lib/timeline'
import type { AgentName, ApprovalRequest, ChatAttachment, EventEnvelope, RunPermissions, Source } from '../lib/types'
import { EventTimeline } from '../components/EventTimeline'
import { NarrativeTimeline } from '../components/NarrativeTimeline'
import { ToolActivityBar } from '../components/ToolActivityBar'
import { WarningsBanner } from '../components/WarningsBanner'
import { FollowupComposer } from '../components/FollowupComposer'
import { StreamingStatus, type ActiveStream } from '../components/StreamingStatus'
import { ReviewPanel, type ReviewThread } from '../components/ReviewPanel'
import { Splitter } from '../components/Splitter'
import { TraceDrawer } from '../components/TraceDrawer'
import { FilesHeatmapDrawer } from '../components/FilesHeatmapDrawer'
import { Icon } from '../components/Icon'
import { AgentIcon } from '../components/AgentIcon'
import { SessionActionsMenu } from '../components/SessionActionsMenu'
import { useResizable } from '../hooks/useResizable'
import {
  PREFERENCES_CHANGED_EVENT,
  readAutoRefreshPreference,
  setAutoRefreshPreference,
} from '../lib/preferences'

const POLL_MS = 2000
type AttachmentDraft =
  | Pick<Extract<ChatAttachment, { kind: 'file' | 'directory' }>, 'kind' | 'path' | 'name'>
  | { kind: 'imageData'; dataUrl: string; name: string; mimeType: string }
type CliSelection = Partial<Record<'model' | 'effort', string>>
type CliSelectionByAgent = Partial<Record<AgentName, CliSelection>>

function canNativeResume(source: string | undefined): boolean {
  return source === 'claude-code' || source === 'codex' || source === 'opencode'
}

function isGroupSource(source: string | undefined): boolean {
  return source === 'cockpit'
}

function isServerRunClientId(clientId: string): boolean {
  return clientId.startsWith('run_') || clientId.startsWith('native_run_')
}

function isGroupTurnClientId(clientId: string): boolean {
  return clientId.startsWith('group_turn:')
}

// 只产出 message key,显示文案在渲染处经 t() 取(数据层不产人类语言)。
function approvalIntent(approval: ApprovalRequest): {
  verbKey: MessageKey
  target: string
  tone: 'write' | 'shell' | 'network' | 'read'
  labelKey: MessageKey
} {
  const op = approval.operation
  if (op.kind === 'file_write') {
    const verbKey: MessageKey =
      op.action === 'delete'
        ? 'approval.actionDelete'
        : op.action === 'create'
        ? 'approval.actionCreate'
        : 'approval.actionWrite'
    return { verbKey, target: op.path, tone: 'write', labelKey: 'approval.fileChange' }
  }
  if (op.kind === 'shell') {
    return { verbKey: 'approval.execute', target: op.command, tone: 'shell', labelKey: 'approval.shell' }
  }
  if (op.kind === 'network') {
    return {
      verbKey: 'approval.visit',
      target: op.url ?? op.host ?? '',
      tone: 'network',
      labelKey: 'approval.networkLabel',
    }
  }
  return { verbKey: 'approval.read', target: op.path, tone: 'read', labelKey: 'approval.fileRead' }
}

function approvalPreview(target: string): string {
  const compact = target.replace(/\s+/g, ' ').trim()
  return compact.length > 120 ? `${compact.slice(0, 120)}…` : compact
}

function approvalFromEnvelope(env: EventEnvelope): ApprovalRequest | null {
  if (env.event.type !== 'meta' || env.event.key !== 'approval_required') return null
  const approval = env.event.value as ApprovalRequest | undefined
  return typeof approval?.approvalId === 'string' ? approval : null
}

function resolvedApprovalIdFromEnvelope(env: EventEnvelope): string | null {
  if (env.event.type !== 'meta' || env.event.key !== 'approval_resolved') return null
  const value = env.event.value as { approvalId?: string } | undefined
  return typeof value?.approvalId === 'string' ? value.approvalId : null
}

function pendingApprovalsFromEvents(events: EventEnvelope[]): ApprovalRequest[] {
  const pending = new Map<string, ApprovalRequest>()
  for (const env of events) {
    const approval = approvalFromEnvelope(env)
    if (approval) pending.set(approval.approvalId, approval)
    const resolved = resolvedApprovalIdFromEnvelope(env)
    if (resolved) pending.delete(resolved)
  }
  return [...pending.values()]
}

function lastGroupDiscussionMode(events: EventEnvelope[]): 'parallel' | 'serial' {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i].event
    if (ev.type !== 'meta' || ev.key !== 'turn_start') continue
    const value = ev.value as { mode?: string } | undefined
    return value?.mode === 'serial' ? 'serial' : 'parallel'
  }
  return 'parallel'
}

interface ReviewRoomMeta {
  enabled?: boolean
  sourceKind?: string
  parentReviewRoomId?: string
}

function reviewRoomMeta(summary: SessionDetailDTO['summary'] | null): ReviewRoomMeta | null {
  const raw = summary?.extensions?.reviewRoom
  if (!raw || typeof raw !== 'object') return null
  const meta = raw as ReviewRoomMeta
  return meta.enabled ? meta : null
}

export function SessionDetail() {
  const { t } = useI18n()
  const { source, id } = useParams()
  const navigate = useNavigate()
  const { width: reviewWidth, onDragStart: onReviewDrag } = useResizable(
    'cockpit.reviewWidth',
    360,
    240,
    700,
    'right',
  )
  const [detail, setDetail] = useState<SessionDetailDTO | null>(null)
  const [reviewRoom, setReviewRoom] = useState<ReviewRoomState | null>(null)
  const [extractingIssues, setExtractingIssues] = useState(false)
  const [freshReviewBusy, setFreshReviewBusy] = useState(false)
  const [events, setEvents] = useState<EventEnvelope[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<FilterKind>('all')
  const [keyword, setKeyword] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(() => readAutoRefreshPreference())
  const [live, setLive] = useState(false)
  const [streams, setStreams] = useState<ActiveStream[]>([])
  const [sendError, setSendError] = useState<string | null>(null)
  const [reviewStateWarning, setReviewStateWarning] = useState<string | null>(null)
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([])
  const [expandedApprovals, setExpandedApprovals] = useState<Set<string>>(new Set())
  const [activeTrace, setActiveTrace] = useState<TraceGroup | null>(null)
  // 客户端 partition 兜底:即便 server 没回写 parentTurnId / 历史 user_text 没 targetAgent,
  // 也能把 child 轮归回旁路 thread。送出请求时就锁定,不依赖 SSE/loader 字段。
  const [clientChainHints, setClientChainHints] = useState<{
    parentOf: Record<string, string>
    agentOf: Record<string, AgentName>
  }>({ parentOf: {}, agentOf: {} })

  // Phase 2 opt-in:per-thread 记忆「Codex 加速模式(native-linked)」开关。
  // 只影响 Codex agent 的 follow-up。默认关闭,LocalStorage per (source, id) 持久化。
  const codexAccelStorageKey = source && id ? `cockpit:codex-accel:${source}:${id}` : null
  const [codexAcceleratedMode, setCodexAcceleratedModeState] = useState(false)
  useEffect(() => {
    if (!codexAccelStorageKey) return
    try {
      setCodexAcceleratedModeState(window.localStorage.getItem(codexAccelStorageKey) === '1')
    } catch {
      /* SSR / storage 不可用时忽略 */
    }
  }, [codexAccelStorageKey])
  const setCodexAcceleratedMode = useCallback(
    (next: boolean) => {
      setCodexAcceleratedModeState(next)
      if (!codexAccelStorageKey) return
      try {
        if (next) window.localStorage.setItem(codexAccelStorageKey, '1')
        else window.localStorage.removeItem(codexAccelStorageKey)
      } catch {
        /* ignore */
      }
    },
    [codexAccelStorageKey],
  )

  const eventsLenRef = useRef(0)
  const eventsRef = useRef<EventEnvelope[]>([])
  const seenIds = useRef<Set<string>>(new Set())
  const streamsRef = useRef<ActiveStream[]>([])
  const abortsRef = useRef<Map<string, () => void>>(new Map())
  eventsLenRef.current = events.length
  eventsRef.current = events
  streamsRef.current = streams

  // 打字机 pacer:每个流式 assistant_text(按 turn/run/agent 分组)对应一个占位 envelope,
  // 后续 delta 的文本进入 buffered 队列,rAF 按帧吐几字符出来,视觉更顺滑。
  // - 非 delta assistant_text 到达 → 立刻 flush 该 key 的剩余 buffer(避免终态一坨盖过来)
  // - 切 session / reset → 全部 flush + 清空
  // - 队列积压过大时倍速追赶,保证总时长不落后 API 太多
  type PacerEntry = { envelopeId: string; buffered: string; displayed: string }
  const pacerByKey = useRef<Map<string, PacerEntry>>(new Map())
  const rafRef = useRef<number | null>(null)

  const streamKeyOf = (env: EventEnvelope): string => {
    const ev = env.event
    const agent = 'agent' in ev ? ev.agent ?? '' : ''
    return `${env.turnId ?? ''}:${env.runId ?? ''}:${agent}`
  }

  const applyPacerUpdates = useCallback((updates: Map<string, string>) => {
    if (updates.size === 0) return
    setEvents((prev) =>
      prev.map((e) => {
        const key = e.sourceEventId ? updates.get(e.sourceEventId) : undefined
        if (key === undefined) return e
        const ev = e.event
        if (ev.type !== 'assistant_text') return e
        return { ...e, event: { ...ev, text: key } }
      }),
    )
  }, [])

  const drainPacer = useCallback(() => {
    rafRef.current = null
    const updates = new Map<string, string>()
    let stillActive = false
    for (const p of pacerByKey.current.values()) {
      if (p.buffered.length === 0) continue
      const backlog = p.buffered.length
      // 目标 ~4ms/字符(60fps 下约 4 字/帧);积压 > 120 追平,> 40 半速,少也保底 3 字/帧
      const take =
        backlog > 120
          ? backlog
          : backlog > 40
            ? Math.max(4, Math.ceil(backlog / 2))
            : Math.max(3, Math.ceil(backlog / 6))
      const chunk = p.buffered.slice(0, take)
      p.buffered = p.buffered.slice(take)
      p.displayed += chunk
      updates.set(p.envelopeId, p.displayed)
      if (p.buffered.length > 0) stillActive = true
    }
    applyPacerUpdates(updates)
    if (stillActive) rafRef.current = requestAnimationFrame(drainPacer)
  }, [applyPacerUpdates])

  const kickPacer = useCallback(() => {
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(drainPacer)
  }, [drainPacer])

  const flushPacer = useCallback(
    (onlyKey?: string) => {
      const updates = new Map<string, string>()
      const keys = onlyKey ? [onlyKey] : Array.from(pacerByKey.current.keys())
      for (const k of keys) {
        const p = pacerByKey.current.get(k)
        if (!p) continue
        if (p.buffered.length > 0) {
          p.displayed += p.buffered
          p.buffered = ''
          updates.set(p.envelopeId, p.displayed)
        }
        pacerByKey.current.delete(k)
      }
      applyPacerUpdates(updates)
    },
    [applyPacerUpdates],
  )

  const syncApprovalEnvelope = useCallback((env: EventEnvelope) => {
    const approval = approvalFromEnvelope(env)
    if (approval) {
      setPendingApprovals((prev) =>
        prev.some((a) => a.approvalId === approval.approvalId) ? prev : [...prev, approval],
      )
    }
    const resolved = resolvedApprovalIdFromEnvelope(env)
    if (resolved) {
      setPendingApprovals((prev) => prev.filter((a) => a.approvalId !== resolved))
      setExpandedApprovals((prev) => {
        if (!prev.has(resolved)) return prev
        const next = new Set(prev)
        next.delete(resolved)
        return next
      })
    }
  }, [])

  // 去重追加(不变量 12):按 sourceEventId,无 id 用 seenIds 当前大小兜底。
  // 注意:seenIds 必须在 setState 之外更新——React StrictMode 会把 updater 跑两次,
  // 若在 updater 里 add,第二次跑就把刚追加的事件当成"已见过"丢掉,UI 看似永远收不到。
  const appendEnvelopes = useCallback(
    (incoming: EventEnvelope[]) => {
      if (incoming.length === 0) return
      const fresh: EventEnvelope[] = []
      let bufferedSomething = false
      for (const e of incoming) {
        const k = e.sourceEventId ?? `#${seenIds.current.size}`
        if (seenIds.current.has(k)) continue
        seenIds.current.add(k)
        syncApprovalEnvelope(e)

        const ev = e.event
        if (ev.type === 'assistant_text' && ev.delta) {
          const key = streamKeyOf(e)
          const existing = pacerByKey.current.get(key)
          if (existing) {
            existing.buffered += ev.text
          } else {
            // 首条 delta:压入一个 text 为空的占位 envelope,后续 delta 只喂 buffer
            pacerByKey.current.set(key, {
              envelopeId: k,
              buffered: ev.text,
              displayed: '',
            })
            fresh.push({ ...e, sourceEventId: k, event: { ...ev, text: '' } })
          }
          bufferedSomething = true
          continue
        }
        // 非 delta assistant_text(终态)到达 → 立刻把该 key 的 buffer 吐完再插入
        if (ev.type === 'assistant_text' && !ev.delta) {
          flushPacer(streamKeyOf(e))
        }
        fresh.push(e)
      }
      if (fresh.length > 0) setEvents((prev) => [...prev, ...fresh])
      if (bufferedSomething) kickPacer()
    },
    [flushPacer, kickPacer, syncApprovalEnvelope],
  )

  const resetFrom = useCallback((d: SessionDetailDTO) => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    pacerByKey.current.clear()
    setDetail(d)
    setEvents(d.events)
    setPendingApprovals(pendingApprovalsFromEvents(d.events))
    setExpandedApprovals(new Set())
    seenIds.current = new Set(d.events.map((e, i) => e.sourceEventId ?? `#${i}`))
  }, [])

  useEffect(() => {
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      pacerByKey.current.clear()
    }
  }, [])

  const noteApproval = useCallback((approval: ApprovalRequest) => {
    setPendingApprovals((prev) =>
      prev.some((a) => a.approvalId === approval.approvalId) ? prev : [...prev, approval],
    )
  }, [])

  const resolveApprovalInUi = useCallback((approvalId: string) => {
    setPendingApprovals((prev) => prev.filter((a) => a.approvalId !== approvalId))
    setExpandedApprovals((prev) => {
      if (!prev.has(approvalId)) return prev
      const next = new Set(prev)
      next.delete(approvalId)
      return next
    })
  }, [])

  const decideApproval = useCallback(
    // approve = 仅本次;approve-always = 本轮 run 内同类操作不再询问(docs/12 C2)。
    async (approvalId: string, decision: 'approve' | 'approve-always' | 'reject') => {
      try {
        const action = decision === 'reject' ? 'reject' : 'approve'
        const res = await fetch(`/api/approvals/${encodeURIComponent(approvalId)}/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope: decision === 'approve-always' ? 'always' : 'once' }),
        })
        if (!res.ok) throw new Error(`${res.status}`)
        resolveApprovalInUi(approvalId)
      } catch (e) {
        setSendError(t('approval.failed', { error: String((e as Error)?.message ?? e) }))
      }
    },
    [resolveApprovalInUi],
  )

  const findParentTurnId = useCallback((turnId: string): string | undefined => {
    for (const env of eventsRef.current) {
      if (env.turnId !== turnId) continue
      if (env.event.type === 'user_text' && env.event.parentTurnId) return env.event.parentTurnId
    }
    return undefined
  }, [])

  const attachFollowupRun = useCallback(
    (run: RunRecord, parentTurnId?: string) => {
      if (!source || !id || isGroupSource(source)) return
      const clientId = run.runId
      if (abortsRef.current.has(clientId)) return
      const agent = run.agent as AgentName
      const ac = new AbortController()
      abortsRef.current.set(clientId, () => ac.abort())
      setStreams((prev) =>
        prev.some((s) => s.clientId === clientId)
          ? prev
          : [
              ...prev,
              {
                clientId,
                agent,
                turnId: run.turnId,
                rootTurnId: parentTurnId ?? run.turnId,
                startedAt: Date.parse(run.startedAt) || Date.now(),
              },
            ],
      )
      if (parentTurnId) {
        setClientChainHints((h) => ({
          parentOf: { ...h.parentOf, [run.turnId]: parentTurnId },
          agentOf: { ...h.agentOf, [parentTurnId]: agent },
        }))
      } else {
        setClientChainHints((h) => ({
          ...h,
          agentOf: { ...h.agentOf, [run.turnId]: agent },
        }))
      }

      const cleanup = (reason: 'done' | 'aborted' | 'error', message?: string) => {
        abortsRef.current.delete(clientId)
        setStreams((prev) => prev.filter((s) => s.clientId !== clientId))
        const status = reason === 'done' ? 'completed' : reason
        appendEnvelopes([
          {
            origin: 'cockpit',
            source: source as Source,
            sourceEventId: `status:${run.turnId}:${status}`,
            turnId: run.turnId,
            runId: run.runId,
            event: {
              type: 'meta',
              key: 'turn_status',
              value: reason === 'error' ? { status, error: message } : { status },
              ts: new Date().toISOString(),
            },
          },
        ])
        if (reason === 'error') setSendError(message ?? t('detail.requestFailed'))
      }

      attachRunStream(
        run.runId,
        (msg: RunStreamMessage) => {
          if (msg.kind === 'meta' && 'turnId' in msg) {
            setStreams((prev) =>
              prev.map((s) =>
                s.clientId === clientId
                  ? { ...s, turnId: msg.turnId, rootTurnId: s.rootTurnId ?? msg.turnId }
                  : s,
              ),
            )
          } else if (msg.kind === 'run_phase' && !('groupTurnId' in msg)) {
            setStreams((prev) => prev.map((s) => (s.clientId === clientId ? { ...s, phase: msg.phase } : s)))
          } else if (msg.kind === 'event' && !('groupTurnId' in msg)) {
            const list: EventEnvelope[] = []
            if (agent === sessionAgentOf(source)) {
              const bKey = `boundary:${source}:${id}`
              if (!seenIds.current.has(bKey)) {
                list.push({
                  origin: 'cockpit',
                  source: source as Source,
                  sourceEventId: bKey,
                  event: { type: 'followup_boundary', ts: msg.envelope.event.ts },
                })
              }
            }
            list.push(msg.envelope)
            appendEnvelopes(list)
          } else if (msg.kind === 'approval_required') {
            noteApproval(msg.approval)
          } else if (msg.kind === 'approval_resolved') {
            resolveApprovalInUi(msg.approvalId)
          } else if (msg.kind === 'done') {
            cleanup('done')
          } else if (msg.kind === 'aborted') {
            cleanup('aborted')
          } else if (msg.kind === 'error') {
            cleanup('error', msg.message)
          }
        },
        ac.signal,
      ).catch((e) => {
        if (!ac.signal.aborted) cleanup('error', String(e))
      })
    },
    [source, id, appendEnvelopes, noteApproval, resolveApprovalInUi],
  )

  const attachGroupRun = useCallback(
    (run: RunRecord) => {
      if (!id || !isGroupSource(source)) return
      const clientId = run.runId
      if (abortsRef.current.has(clientId)) return
      const agent = run.agent as AgentName
      const ac = new AbortController()
      abortsRef.current.set(clientId, () => ac.abort())
      setStreams((prev) =>
        prev.some((s) => s.clientId === clientId)
          ? prev
          : [
              ...prev,
              {
                clientId,
                agent,
                turnId: run.turnId,
                rootTurnId: run.turnId,
                startedAt: Date.parse(run.startedAt) || Date.now(),
              },
            ],
      )

      const cleanup = (reason: 'done' | 'aborted' | 'error', message?: string) => {
        abortsRef.current.delete(clientId)
        setStreams((prev) => prev.filter((s) => s.clientId !== clientId))
        if (reason === 'error') setSendError(message ?? t('detail.groupSendFailed'))
      }

      attachRunStream(
        run.runId,
        (msg: RunStreamMessage) => {
          if (msg.kind === 'meta' && 'groupTurnId' in msg) {
            setStreams((prev) =>
              prev.map((s) => (s.clientId === clientId ? { ...s, turnId: msg.groupTurnId, rootTurnId: msg.groupTurnId } : s)),
            )
          } else if (msg.kind === 'run_phase' && 'groupTurnId' in msg && msg.runId === run.runId) {
            setStreams((prev) => prev.map((s) => (s.clientId === clientId ? { ...s, phase: msg.phase } : s)))
          } else if (msg.kind === 'event' && 'groupTurnId' in msg) {
            appendEnvelopes([msg.envelope])
          } else if (msg.kind === 'approval_required') {
            noteApproval(msg.approval)
          } else if (msg.kind === 'approval_resolved') {
            resolveApprovalInUi(msg.approvalId)
          } else if (msg.kind === 'run_done' && msg.runId === run.runId) {
            cleanup(msg.status === 'completed' ? 'done' : msg.status === 'aborted' ? 'aborted' : 'error', msg.message)
          } else if (msg.kind === 'error') {
            cleanup('error', msg.message)
          }
        },
        ac.signal,
      ).catch((e) => {
        if (!ac.signal.aborted) cleanup('error', String(e))
      })
    },
    [source, id, appendEnvelopes, noteApproval, resolveApprovalInUi],
  )

  const attachGroupTurn = useCallback(
    (groupTurnId: string) => {
      if (!id || !isGroupSource(source)) return
      const clientId = `group_turn:${groupTurnId}`
      if (abortsRef.current.has(clientId)) return
      const ac = new AbortController()
      abortsRef.current.set(clientId, () => ac.abort())
      const cleanup = (reason: 'done' | 'aborted' | 'error', message?: string) => {
        abortsRef.current.delete(clientId)
        setStreams((prev) => prev.filter((s) => s.turnId !== groupTurnId))
        if (reason === 'error') setSendError(message ?? t('detail.serialFailed'))
      }
      attachGroupTurnStream(
        id,
        groupTurnId,
        (msg: RunStreamMessage) => {
          if (msg.kind === 'serial_step') {
            const agent = msg.agent as AgentName
            const serial = { step: msg.step, maxSteps: msg.maxSteps }
            setStreams((prev) =>
              prev.some((s) => s.clientId === msg.runId)
                ? // 同一个 run 上重复收到 serial_step(协议修复复用同一步号)时更新进度即可。
                  prev.map((s) => (s.clientId === msg.runId ? { ...s, serial } : s))
                : [
                    ...prev,
                    {
                      clientId: msg.runId,
                      agent,
                      turnId: groupTurnId,
                      rootTurnId: groupTurnId,
                      startedAt: Date.now(),
                      serial,
                    },
                  ],
            )
          } else if (msg.kind === 'run_phase' && 'groupTurnId' in msg) {
            setStreams((prev) => prev.map((s) => (s.clientId === msg.runId ? { ...s, phase: msg.phase } : s)))
          } else if (msg.kind === 'event' && 'groupTurnId' in msg) {
            appendEnvelopes([msg.envelope])
          } else if (msg.kind === 'approval_required') {
            noteApproval(msg.approval)
          } else if (msg.kind === 'approval_resolved') {
            resolveApprovalInUi(msg.approvalId)
          } else if (msg.kind === 'run_done') {
            setStreams((prev) => prev.filter((s) => s.clientId !== msg.runId))
          } else if (msg.kind === 'done' && 'groupTurnId' in msg) {
            cleanup(msg.status === 'completed' ? 'done' : msg.status === 'aborted' ? 'aborted' : 'error', msg.message)
          } else if (msg.kind === 'error') {
            cleanup('error', msg.message)
          }
        },
        ac.signal,
      ).catch((e) => {
        if (!ac.signal.aborted) cleanup('error', String(e))
      })
    },
    [source, id, appendEnvelopes, noteApproval, resolveApprovalInUi],
  )

  const attachNativeRun = useCallback(
    (run: RunRecord) => {
      if (!source || !id || !canNativeResume(source)) return
      const clientId = run.runId
      if (abortsRef.current.has(clientId)) return
      const agent = run.agent as AgentName
      const ac = new AbortController()
      abortsRef.current.set(clientId, () => ac.abort())
      setStreams((prev) =>
        prev.some((s) => s.clientId === clientId)
          ? prev
          : [
              ...prev,
              {
                clientId,
                agent,
                turnId: run.turnId,
                rootTurnId: run.turnId,
                startedAt: Date.parse(run.startedAt) || Date.now(),
              },
            ],
      )

      const cleanup = async (reason: 'done' | 'aborted' | 'error', message?: string) => {
        abortsRef.current.delete(clientId)
        setStreams((prev) => prev.filter((s) => s.clientId !== clientId))
        if (reason === 'error') setSendError(message ?? t('detail.nativeResumeFailed'))
        if (reason === 'done') {
          try {
            const d = await fetchSessionDetail(source, id)
            resetFrom(d)
            setLive(true)
          } catch (e) {
            setSendError(t('detail.nativeResumeRefreshFailed', { error: String(e) }))
          }
        }
      }

      attachRunStream(
        run.runId,
        (msg: RunStreamMessage) => {
          if (msg.kind === 'meta' && 'turnId' in msg) {
            setStreams((prev) =>
              prev.map((s) => (s.clientId === clientId ? { ...s, turnId: msg.turnId, rootTurnId: msg.turnId } : s)),
            )
          } else if (msg.kind === 'run_phase' && !('groupTurnId' in msg)) {
            setStreams((prev) => prev.map((s) => (s.clientId === clientId ? { ...s, phase: msg.phase } : s)))
          } else if (msg.kind === 'event' && !('groupTurnId' in msg)) {
            appendEnvelopes([msg.envelope])
          } else if (msg.kind === 'done' && 'turnId' in msg) {
            cleanup('done')
          } else if (msg.kind === 'aborted') {
            cleanup('aborted')
          } else if (msg.kind === 'error') {
            cleanup('error', msg.message)
          }
        },
        ac.signal,
      ).catch((e) => {
        if (!ac.signal.aborted) cleanup('error', String(e))
      })
    },
    [source, id, appendEnvelopes, resetFrom],
  )

  // 初次加载 / 切换 session。
  useEffect(() => {
    if (!source || !id) return
    setLoading(true)
    setError(null)
    setDetail(null)
    setReviewRoom(null)
    setEvents([])
    setSendError(null)
    setReviewStateWarning(null)
    setPendingApprovals([])
    // 切 session 时只断开当前页面的订阅。follow-up run 留在服务端继续跑,显式取消才 abort。
    for (const abort of abortsRef.current.values()) abort()
    abortsRef.current.clear()
    setStreams([])
    let alive = true
    fetchSessionDetail(source, id)
      .then((d) => {
        if (!alive) return
        resetFrom(d)
        setLoading(false)
        if (isGroupSource(source)) {
          const isReview = d.summary?.extensions?.reviewRoom
          if (isReview) {
            fetchReviewRoom(id)
              .then((r) => alive && setReviewRoom(r))
              .catch((e) => alive && setReviewStateWarning(String((e as Error)?.message ?? e)))
          }
          fetchRunningRuns()
            .then((runs) => {
              if (!alive) return
              for (const run of runs) {
                if (run.kind === 'group-member' && run.groupThreadId === id) attachGroupRun(run as RunRecord)
              }
            })
            .catch(() => {})
        } else {
          fetchActiveRuns(source, id)
            .then((runs) => {
              if (!alive) return
              for (const run of runs) {
                if (run.kind === 'native-resume') attachNativeRun(run)
                else {
                  const parentTurnId = run.parentTurnId ?? findParentTurnId(run.turnId)
                  attachFollowupRun(run, parentTurnId)
                }
              }
            })
            .catch(() => {})
        }
      })
      .catch((e) => alive && (setError(String(e)), setLoading(false)))
    return () => {
      alive = false
    }
  }, [source, id, resetFrom, attachFollowupRun, attachGroupRun, attachNativeRun, findParentTurnId])

  useEffect(() => {
    const onPrefs = () => setAutoRefresh(readAutoRefreshPreference())
    window.addEventListener(PREFERENCES_CHANGED_EVENT, onPrefs)
    return () => window.removeEventListener(PREFERENCES_CHANGED_EVENT, onPrefs)
  }, [])

  // 实时增量(Phase 3)。优先用 fs.watch + SSE,失败时回落到轮询(Phase 1.5 兜底)。
  // 任何活跃的 follow-up SSE 期间暂停(不变量 12,避免与流式 envelope 重复)。
  useEffect(() => {
    if (!source || !id || !autoRefresh || loading || error) return

    let alive = true
    let mode: 'sse' | 'poll' = 'sse'
    let sseFailures = 0
    let pollTimer: ReturnType<typeof setInterval> | null = null
    let sseAbort: AbortController | null = null

    const runPoll = async () => {
      if (!alive || document.hidden || streamsRef.current.length > 0) return
      try {
        const since = eventsLenRef.current
        const res = await fetchChanges(source, id, since)
        if (!alive) return
        if (res.reset || res.total < since) {
          const d = await fetchSessionDetail(source, id)
          if (alive) resetFrom(d)
          return
        }
        if (res.changed && res.newEvents.length) {
          appendEnvelopes(res.newEvents)
          setLive(true)
        }
      } catch {
        /* 静默 */
      }
    }

    const startPoll = () => {
      mode = 'poll'
      pollTimer = setInterval(runPoll, POLL_MS)
    }

    const stopAll = () => {
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
      if (sseAbort) {
        sseAbort.abort()
        sseAbort = null
      }
    }

    const startSse = () => {
      mode = 'sse'
      sseAbort = new AbortController()
      const ac = sseAbort
      // 注意:这里把当前 events.length 作为 since 一次性截图;后续完全由 SSE 推。
      // 切 session / autoRefresh 切换时整个 effect 会重建,since 会重新算。
      subscribeSessionStream(
        source,
        id,
        eventsLenRef.current,
        (msg) => {
          if (!alive) return
          // 后台时不消费 append/reset(回到前台后由 effect 重启重新对齐)。
          if (document.hidden) return
          // follow-up 流式期间不消费,避免与 SSE envelope 重复(不变量 12)。
          if (streamsRef.current.length > 0) return
          if (msg.kind === 'init' || msg.kind === 'append') {
            if (msg.newEvents.length) {
              appendEnvelopes(msg.newEvents)
              setLive(true)
            }
          } else if (msg.kind === 'reset') {
            fetchSessionDetail(source, id)
              .then((d) => alive && resetFrom(d))
              .catch(() => {
                /* 静默 */
              })
          }
        },
        ac.signal,
      ).catch(() => {
        if (!alive || ac.signal.aborted) return
        sseFailures++
        if (sseFailures >= 3) {
          // 连续 3 次 SSE 出错 → 回落 poll,这次就不再尝试 SSE。
          startPoll()
        } else {
          // 短暂退避后重连。
          setTimeout(() => {
            if (alive && mode === 'sse') startSse()
          }, 1000 * sseFailures)
        }
      })
    }

    startSse()

    const onVisibility = () => {
      if (!alive) return
      if (document.hidden) {
        stopAll()
      } else {
        // 回到前台:先全量对齐(避免 SSE 在后台漏掉的事件累积一大坨),再重启 SSE。
        fetchSessionDetail(source, id)
          .then((d) => {
            if (!alive) return
            resetFrom(d)
            if (mode === 'sse') startSse()
            else startPoll()
          })
          .catch(() => {
            if (alive && mode === 'sse') startSse()
          })
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      alive = false
      stopAll()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [source, id, autoRefresh, loading, error, resetFrom, appendEnvelopes])

  // 活跃 run 期间上方 effect 会丢弃 session stream 的 append(避免 reset/打字机 pacer
  // 与 run stream 冲突),但服务端游标照常前进,丢弃窗口内该 session 文件的其他增长
  // (另一窗口的 follow-up、终端里的原生续写)不会再推。这里在「最后一个 run 结束」时
  // 做一次 changes 对齐补回;已收过的事件靠 sourceEventId 去重(docs/12 F3,不变量 13)。
  const hadStreamsRef = useRef(false)
  useEffect(() => {
    if (streams.length > 0) {
      hadStreamsRef.current = true
      return
    }
    if (!hadStreamsRef.current) return
    hadStreamsRef.current = false
    if (id && isGroupSource(source) && reviewRoom) {
      fetchReviewRoom(id).then((r) => r && setReviewRoom(r)).catch(() => {})
    }
    if (!source || !id || !autoRefresh || loading || error) return
    let alive = true
    fetchChanges(source, id, eventsLenRef.current)
      .then(async (res) => {
        if (!alive) return
        if (res.reset || res.total < eventsLenRef.current) {
          const d = await fetchSessionDetail(source, id)
          if (alive) resetFrom(d)
        } else if (res.changed && res.newEvents.length) {
          appendEnvelopes(res.newEvents)
        }
      })
      .catch(() => {
        /* 静默:SSE/poll 恢复消费后会自然对齐 */
      })
    return () => {
      alive = false
    }
  }, [streams.length, source, id, autoRefresh, loading, error, resetFrom, appendEnvelopes, reviewRoom])

  // 发一条 follow-up,可能并行发到多个 agent(@-mentions)。
  const handleSend = useCallback(
    (
      text: string,
      agents: AgentName[],
      parentTurnId?: string,
      cli?: { model?: string; effort?: string },
      attachments?: AttachmentDraft[],
      permissions?: RunPermissions,
      extras?: { codexAcceleratedMode?: boolean },
    ) => {
      if (!source || !id || agents.length === 0) return
      setSendError(null)
      for (const agent of agents) {
        // 即便 root 的旧 user_text 没存 targetAgent,也立刻把 root→agent 记下;child→root
        // 等 meta 拿到 turnId 再补。
        if (parentTurnId) {
          setClientChainHints((h) => ({
            ...h,
            agentOf: { ...h.agentOf, [parentTurnId]: agent },
          }))
        }
        startFollowupRun(source, id, {
            text,
            targetAgent: agent,
            useTools: true,
            parentTurnId,
            model: cli?.model,
            effort: cli?.effort,
            attachments,
            permissions,
            // Phase 2:仅 Codex 目标 agent 消费该开关。
            codexAcceleratedMode: agent === 'codex' ? extras?.codexAcceleratedMode === true : undefined,
          })
          .then(({ run, userEnvelope }) => {
            appendEnvelopes([userEnvelope])
            const rootForThis = parentTurnId ?? run.turnId
            if (parentTurnId) {
              setClientChainHints((h) => ({
                parentOf:
                  run.turnId !== parentTurnId
                    ? { ...h.parentOf, [run.turnId]: parentTurnId }
                    : h.parentOf,
                agentOf: { ...h.agentOf, [rootForThis]: agent },
              }))
            }
            attachFollowupRun(run, parentTurnId)
          })
          .catch((e) => setSendError(String(e)))
      }
    },
    [source, id, appendEnvelopes, attachFollowupRun],
  )

  const handleGroupSend = useCallback(
    (
      text: string,
      agents: AgentName[],
      options?: CliSelection | CliSelectionByAgent,
      attachments?: AttachmentDraft[],
      permissions?: RunPermissions,
      extras?: {
        codexAcceleratedMode?: boolean
        groupMode?: 'parallel' | 'serial'
        groupParticipants?: AgentName[]
        serial?: {
          participants?: AgentName[]
          firstAgent?: AgentName
          maxSteps?: number
          stopOnConsensus?: boolean
          preset?: 'architecture-first' | 'implementation-first' | 'peer-review'
        }
      },
    ) => {
      if (!id) return
      setSendError(null)
      startGroupRun(
        id,
        {
          text,
          mode: extras?.groupMode ?? 'parallel',
          targetAgents: agents,
          participants: extras?.groupParticipants,
          serial: extras?.serial,
          useTools: true,
          cliByAgent: options as CliSelectionByAgent | undefined,
          attachments,
          permissions,
          // Phase 2:仅当 targets 中含 codex 且用户开启时,后端 executeGroupMember 才会为 codex member 建 link。
          codexAcceleratedMode:
            extras?.codexAcceleratedMode === true && agents.includes('codex') ? true : undefined,
        },
      )
        .then(({ groupTurnId, mode, records, userEnvelope, turnStart }) => {
          appendEnvelopes([userEnvelope, ...(turnStart ? [turnStart] : [])])
          if (mode === 'serial') attachGroupTurn(groupTurnId)
          else for (const run of records) attachGroupRun(run)
        })
        .catch((e) => setSendError(String(e)))
    },
    [id, appendEnvelopes, attachGroupRun, attachGroupTurn],
  )

  const handleReviewRoomFinish = useCallback(
    (done: boolean, conclusion?: string) => {
      if (!id) return
      setSendError(null)
      finishReviewRoom(id, { done, ...(conclusion !== undefined ? { conclusion } : {}) })
        .then((r) => r && setReviewRoom(r))
        .catch((e) => setSendError(t('detail.finishFailed', { error: String(e) })))
    },
    [id, t],
  )

  const handleManualFix = useCallback(
    (active: boolean) => {
      if (!id) return
      setSendError(null)
      setManualFix(id, active)
        .then((r) => r && setReviewRoom(r))
        .catch((e) => setSendError(t('detail.finishFailed', { error: String(e) })))
    },
    [id, t],
  )

  const handleSetIssueStatus = useCallback(
    (roundId: string, issueId: string, status: import('../lib/api').ReviewIssueStatus | null) => {
      if (!id) return
      setSendError(null)
      setReviewIssueStatus(id, { roundId, issueId, status })
        .then((r) => r && setReviewRoom(r))
        .catch((e) => setSendError(t('detail.issueStatusFailed', { error: String(e) })))
    },
    [id, t],
  )

  const handleReviewRoomStart = useCallback(
    (opts?: { kind?: 'review' | 'fix' | 'verify'; mode?: 'parallel' | 'serial'; participants?: AgentName[] }) => {
      if (!id) return
      setSendError(null)
      startReviewRoomRun(id, {
        mode: opts?.mode ?? 'parallel',
        kind: opts?.kind ?? 'review',
        participants: opts?.participants,
      })
        .then(({ groupTurnId, mode, records, userEnvelope, turnStart }) => {
          appendEnvelopes([userEnvelope, ...(turnStart ? [turnStart] : [])])
          if (mode === 'serial') attachGroupTurn(groupTurnId)
          else for (const run of records) attachGroupRun(run)
          fetchReviewRoom(id).then((r) => r && setReviewRoom(r)).catch(() => {})
        })
        .catch((e) => setSendError(String(e)))
    },
    [id, appendEnvelopes, attachGroupRun, attachGroupTurn],
  )

  const handleNativeSend = useCallback(
    (text: string, attachments?: AttachmentDraft[], writeMode?: 'read-only' | 'trusted') => {
      if (!source || !id || !canNativeResume(source)) return
      setSendError(null)
      startNativeResumeRun(source, id, { text, attachments, writeMode })
        .then(({ run, userEnvelope }) => {
          appendEnvelopes([userEnvelope])
          attachNativeRun(run)
        })
        .catch((e) => setSendError(String(e)))
    },
    [source, id, appendEnvelopes, attachNativeRun],
  )

  const handleCancelAll = useCallback(() => {
    for (const stream of streamsRef.current) {
      if (isServerRunClientId(stream.clientId)) cancelRun(stream.clientId).catch(() => {})
    }
    if (id && isGroupSource(source)) {
      for (const clientId of abortsRef.current.keys()) {
        if (isGroupTurnClientId(clientId)) cancelGroupTurn(id, clientId.slice('group_turn:'.length)).catch(() => {})
      }
    }
    for (const abort of abortsRef.current.values()) abort()
  }, [source, id])

  const handleCancelOne = useCallback((clientId: string) => {
    if (isServerRunClientId(clientId)) cancelRun(clientId).catch(() => {})
    if (id && isGroupSource(source) && isGroupTurnClientId(clientId)) {
      cancelGroupTurn(id, clientId.slice('group_turn:'.length)).catch(() => {})
    }
    abortsRef.current.get(clientId)?.()
  }, [source, id])

  const handleReveal = useCallback(
    (target: 'native' | 'followups') => {
      if (!source || !id) return
      revealSession(source, id, target).catch((e) => setSendError(t('detail.revealFailed', { error: String(e) })))
    },
    [source, id],
  )

  // 切分 events:旁路 agent 的整条 thread(根 turn + 所有 parentTurnId 指向它的后续 turn)去右栏,
  // 其余留在主 timeline。同根 thread 的多次问答合并为一张可继续对话的卡。
  const partitioned = useMemo(() => {
    const sessionAgent = sessionAgentOf(source)
    const turnAgent = new Map<string, AgentName>()
    const parentOf = new Map<string, string>()
    for (const env of events) {
      if (env.origin !== 'cockpit' || !env.turnId) continue
      if (env.event.type === 'user_text') {
        if (env.event.targetAgent) turnAgent.set(env.turnId, env.event.targetAgent)
        if (env.event.parentTurnId) parentOf.set(env.turnId, env.event.parentTurnId)
      }
    }
    // 兜底:client 端发起时记的 chain hints。覆盖 server 漏写 / 老 thread 文件没存 parent 的情况。
    for (const [child, root] of Object.entries(clientChainHints.parentOf)) {
      if (!parentOf.has(child)) parentOf.set(child, root)
    }
    for (const [t, a] of Object.entries(clientChainHints.agentOf)) {
      if (!turnAgent.has(t)) turnAgent.set(t, a)
    }
    const rootOf = (t: string): string => {
      let cur = t
      const seen = new Set<string>()
      while (parentOf.has(cur) && !seen.has(cur)) {
        seen.add(cur)
        cur = parentOf.get(cur)!
      }
      return cur
    }
    const main: EventEnvelope[] = []
    const reviewMap = new Map<string, { agent: AgentName; events: EventEnvelope[] }>()
    for (const env of events) {
      const tId = env.turnId
      const root = tId ? rootOf(tId) : undefined
      const a = root ? turnAgent.get(root) : undefined
      if (env.origin === 'cockpit' && a && a !== sessionAgent && root) {
        const cur = reviewMap.get(root) ?? { agent: a, events: [] }
        cur.events.push(env)
        reviewMap.set(root, cur)
      } else {
        main.push(env)
      }
    }
    const threads: ReviewThread[] = [...reviewMap.entries()].map(([turnId, v]) => ({
      turnId,
      agent: v.agent,
      events: v.events,
    }))
    return { main, threads, rootOf }
  }, [events, source, clientChainHints])

  const pairs = useMemo(() => buildTimeline(partitioned.main).pairs, [partitioned.main])
  const activity = useMemo(() => summarizeTools(pairs, partitioned.main), [pairs, partitioned.main])
  const groupMode = isGroupSource(source)
  const groupDefaultDiscussionMode = useMemo(() => lastGroupDiscussionMode(events), [events])
  const [showFiles, setShowFiles] = useState(false)
  const [viewMode, setViewMode] = useState<'narrative' | 'detail'>('detail')

  if (loading)
    return (
      <div className="detail">
        <div className="empty">{t('detail.loading')}</div>
      </div>
    )
  if (error)
    return (
      <div className="detail">
        <div className="empty">{t('detail.loadFailed', { error })}</div>
      </div>
    )
  if (!detail) return <div className="detail" />

  const s = detail.summary
  const reviewMeta = reviewRoomMeta(s)
  const isReviewRoom = groupMode && reviewMeta != null
  const reviewStarted = isReviewRoom && (reviewRoom?.rounds.length ?? 0) > 0
  const reviewPhase = reviewRoom?.phase ?? (reviewStarted ? 'review' : 'draft')
  const hasMainStreams = groupMode
    ? streams.length > 0
    : streams.some((s) => s.agent === sessionAgentOf(source))
  const hasReview =
    !groupMode &&
    (partitioned.threads.length > 0 || streams.some((s) => s.agent !== sessionAgentOf(source)))

  return (
    <div className={`detail ${hasReview ? 'detail-with-review' : ''}`}>
      <div className="detail-main">
        <div className="detail-head">
          <div className="detail-title">
            <span
              className={`badge ${s.source} badge-icon`}
              title={sourceLabel(s.source as Source)}
            >
              <AgentIcon source={s.source} size={30} />
            </span>
            <span className="detail-title-text" title={`${s.title}${s.cwd ? `\n${s.cwd}` : ''}`}>
              {displayTitle(s.title)}
            </span>
            <span
              className="detail-event-count"
              title={
                s.cwd
                  ? `${s.cwd}\n${t('detail.eventCount', { count: partitioned.main.length })}`
                  : t('detail.eventCount', { count: partitioned.main.length })
              }
            >
              {partitioned.main.length}
            </span>
            <button
              className={`refresh-badge-btn icon-only ${autoRefresh ? 'active' : ''}`}
              onClick={() => {
                setAutoRefresh((v) => {
                  const next = !v
                  setAutoRefreshPreference(next)
                  return next
                })
                setLive(false)
              }}
              title={
                autoRefresh
                  ? live
                  ? t('detail.autoRefreshLive')
                  : t('detail.autoRefreshOn')
                  : t('detail.autoRefreshPaused')
              }
              aria-label={t('detail.toggleAutoRefresh')}
            >
              <span className={`refresh-indicator-dot ${autoRefresh && live ? 'live' : ''}`} />
            </button>
            <button
              className="head-icon-btn"
              onClick={() => handleReveal('native')}
              title={groupMode ? t('detail.revealGroup') : t('detail.revealSession')}
              aria-label={groupMode ? t('detail.revealGroup') : t('detail.revealSession')}
            >
              <Icon name="folder" size={13} />
            </button>
            {source && id && (
              <SessionActionsMenu
                source={source}
                sessionId={id}
                isGroup={groupMode}
                cwd={s.cwd}
              />
            )}
          </div>
        </div>
        <WarningsBanner warnings={detail.warnings} />
        {isReviewRoom && (
          <>
            <ReviewRoomPanel
              phase={reviewPhase}
              sourceKind={reviewMeta?.sourceKind}
              parentReviewRoomId={reviewMeta?.parentReviewRoomId}
              room={reviewRoom}
              busy={streams.length > 0}
              onStart={handleReviewRoomStart}
              onFinish={handleReviewRoomFinish}
              onManualFix={handleManualFix}
            />
            {reviewRoom && <SourceFreshnessBanner room={reviewRoom} />}
            {reviewRoom && (
              <ReviewCompareView
                room={reviewRoom}
                busy={extractingIssues}
                freshBusy={freshReviewBusy}
                onSetIssueStatus={handleSetIssueStatus}
                onExtract={async () => {
                  if (!id) return
                  setExtractingIssues(true)
                  try {
                    const next = await extractReviewIssues(id, { force: true })
                    if (next) setReviewRoom(next)
                  } catch (e) {
                    setSendError(t('detail.extractFailed', { error: String(e) }))
                  } finally {
                    setExtractingIssues(false)
                  }
                }}
                onFreshReview={async () => {
                  if (!id) return
                  setFreshReviewBusy(true)
                  try {
                    const created = await startFreshReview(id, { reason: 'user-requested' })
                    if (created.startError) setSendError(t('detail.freshReviewStartFailed', { error: created.startError }))
                    navigate(`/cockpit/${encodeURIComponent(created.groupThreadId)}`)
                  } catch (e) {
                    setSendError(t('detail.freshReviewFailed', { error: String(e) }))
                  } finally {
                    setFreshReviewBusy(false)
                  }
                }}
              />
            )}
          </>
        )}
        <ToolActivityBar
          activity={activity}
          filter={filter}
          onFilter={setFilter}
          keyword={keyword}
          onKeyword={setKeyword}
          onShowFiles={() => setShowFiles(true)}
          viewMode={viewMode}
          onViewMode={setViewMode}
        />
        <div className="conversation-area">
          {viewMode === 'narrative' && filter === 'all' && !keyword.trim() ? (
            <NarrativeTimeline
              events={partitioned.main}
              onViewTrace={setActiveTrace}
            />
          ) : (
            <EventTimeline
              events={partitioned.main}
              filter={filter}
              keyword={keyword}
              onViewTrace={setActiveTrace}
            />
          )}
          {pendingApprovals.length > 0 && (
            <div className="approval-stack conversation-banner">
              {pendingApprovals.map((approval) => {
                const { verbKey, target, tone, labelKey } = approvalIntent(approval)
                const expanded = expandedApprovals.has(approval.approvalId)
                return (
                  <div key={approval.approvalId} className={`approval-card approval-tone-${tone} ${expanded ? 'is-expanded' : ''}`}>
                    <div className="approval-icon" aria-hidden="true">
                      <Icon name={tone === 'read' ? 'lock' : tone === 'shell' ? 'wrench' : 'alert-triangle'} size={16} />
                    </div>
                    <div className="approval-main">
                      <div className="approval-head">
                        <span className="approval-agent">{approval.agent}</span>
                        <span className="approval-kind">{t(labelKey)}</span>
                        <span className="approval-verb">{t('approval.requests', { verb: t(verbKey) })}</span>
                      </div>
                      <div className="approval-summary-row">
                        <code className="approval-summary" title={target}>{approvalPreview(target)}</code>
                        {(target || approval.reason) && (
                          <button
                            className="approval-disclosure"
                            onClick={() =>
                              setExpandedApprovals((prev) => {
                                const next = new Set(prev)
                                if (next.has(approval.approvalId)) next.delete(approval.approvalId)
                                else next.add(approval.approvalId)
                                return next
                              })
                            }
                            aria-expanded={expanded}
                          >
                            {expanded ? t('approval.collapse') : t('approval.detail')}
                          </button>
                        )}
                      </div>
                      {expanded && (
                        <div className="approval-details">
                          <code className="approval-target">{target}</code>
                          {approval.reason && <div className="approval-reason">{approval.reason}</div>}
                        </div>
                      )}
                    </div>
                    <div className="approval-actions">
                      <button onClick={() => decideApproval(approval.approvalId, 'reject')}>
                        <Icon name="close" size={14} />
                        {t('approval.reject')}
                      </button>
                      <button
                        title={t('approval.alwaysTitle')}
                        onClick={() => decideApproval(approval.approvalId, 'approve-always')}
                      >
                        <Icon name="check" size={14} />
                        {t('approval.always')}
                      </button>
                      <button className="primary" onClick={() => decideApproval(approval.approvalId, 'approve')}>
                        <Icon name="check" size={14} />
                        {t('approval.once')}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          {sendError && (
          <div className="banner warn conversation-banner">{t('detail.sendFailed', { error: sendError })}</div>
        )}
          {reviewStateWarning && (
            <div className="banner warn conversation-banner">
              {t('reviewRoom.stateCorrupt', { error: reviewStateWarning })}
            </div>
          )}
          <div className="conversation-bottom">
            <StreamingStatus
              streams={groupMode ? streams : streams.filter((s) => s.agent === sessionAgentOf(source))}
              events={events}
            />
            <FollowupComposer
              key={`${source}:${id}:composer`}
              hasActiveStreams={hasMainStreams}
              sessionAgent={sessionAgentOf(source)}
              nativeAvailable={!groupMode && canNativeResume(source)}
              groupMode={groupMode}
              groupDefaultDiscussionMode={groupDefaultDiscussionMode}
              onSend={(t, a, options, attachments, permissions, extras) =>
                groupMode
                  ? handleGroupSend(t, a, options as CliSelectionByAgent | undefined, attachments, permissions, extras)
                  : handleSend(t, a, undefined, options as CliSelection | undefined, attachments, permissions, extras)
              }
              onNativeSend={handleNativeSend}
              onCancelAll={handleCancelAll}
              cwd={s.cwd}
              codexAcceleratedMode={codexAcceleratedMode}
              onCodexAcceleratedModeChange={setCodexAcceleratedMode}
            />
          </div>
        </div>
      </div>
      {hasReview && (
        <Splitter side="right" onDragStart={onReviewDrag} />
      )}
      {hasReview && (
        <ReviewPanel
          style={{ width: reviewWidth }}
          threads={partitioned.threads}
          pending={streams
            .filter((s) => s.agent !== sessionAgentOf(source))
            .map((s) => ({
              clientId: s.clientId,
              agent: s.agent,
              turnId: s.turnId,
              rootTurnId: s.rootTurnId,
            }))}
          onCancel={handleCancelOne}
          onReply={(rootTurnId, agent, text) => handleSend(text, [agent], rootTurnId)}
          onViewTrace={setActiveTrace}
          onReveal={() => handleReveal('followups')}
        />
      )}
      <TraceDrawer
        group={activeTrace}
        onClose={() => setActiveTrace(null)}
      />
      <FilesHeatmapDrawer
        pairs={pairs}
        cwd={s.cwd ?? undefined}
        open={showFiles}
        onClose={() => setShowFiles(false)}
      />
    </div>
  )
}

const ROUND_KIND_LABEL: Record<string, string> = {
  review: 'Review',
  fix: 'Fix',
  verify: 'Verify',
  'fresh-review': 'Fresh review',
}

function relativeTs(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const diff = Math.max(0, Date.now() - t)
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

function ReviewRoomPanel({
  phase,
  sourceKind,
  parentReviewRoomId,
  room,
  busy,
  onStart,
  onFinish,
  onManualFix,
}: {
  phase: string
  sourceKind?: string
  parentReviewRoomId?: string
  room: ReviewRoomState | null
  busy: boolean
  onStart: (opts?: { kind?: 'review' | 'fix' | 'verify'; mode?: 'parallel' | 'serial'; participants?: import('../lib/types').AgentName[] }) => void
  onFinish: (done: boolean, conclusion?: string) => void
  onManualFix: (active: boolean) => void
}) {
  const { t } = useI18n()
  const rounds = room?.rounds ?? []
  const started = rounds.length > 0
  const anyRunning = rounds.some((r) => r.status === 'running')
  // 手动修复只是「在等用户」,不是 agent 在跑,所以不参与 anyRunning。
  const manualFixPending = rounds.some((r) => r.status === 'awaiting-user')
  const [nextKind, setNextKind] = useState<'review' | 'fix' | 'verify'>('review')
  const [nextMode, setNextMode] = useState<'parallel' | 'serial'>('parallel')
  // fix 轮只能有一个 writer(docs/14 §Fix)。'auto' = 交给后端按「非发现者」规则挑,
  // 不在前端复制那套规则,避免两处逻辑漂移。
  const [fixer, setFixer] = useState<AgentName | 'auto'>('auto')
  const [doneDialogOpen, setDoneDialogOpen] = useState(false)
  const participants = room?.participants ?? (['claude', 'codex'] as AgentName[])
  const isDone = room?.phase === 'done'
  const summary = room?.statusSummary
  const canFinish = !anyRunning && (room?.rounds.length ?? 0) > 0
  useEffect(() => {
    if (!started) return setNextKind('review')
    const last = rounds[rounds.length - 1]
    if (last.status === 'running') return
    setNextKind(last.kind === 'review' ? 'fix' : last.kind === 'fix' ? 'verify' : 'review')
  }, [started, rounds])

  return (
    <>
      <div className="review-room-banner">
        <div className="review-room-main">
          <span className="review-room-kicker">
            <span className="review-room-mark"><Icon name="sparkle" size={13} /></span>
            {t('newChat.reviewRoom')}
          </span>
          <span className="review-room-title">
            {t('reviewRoom.collab', {
              agents: (room?.participants ?? ['claude', 'codex']).map(labelForAgent).join(' × '),
            })}
          </span>
          <span className="review-room-meta">
            {sourceKind ? `${sourceKind} · ` : ''}
            {phase}
            {rounds.length ? t('reviewRoom.roundCount', { count: rounds.length }) : ''}
            {manualFixPending && <> · <strong>{t('manualFix.inProgress')}</strong></>}
            {parentReviewRoomId && (
              <>
                {' · '}
                <a
                  href={`/cockpit/${encodeURIComponent(parentReviewRoomId)}`}
                  className="review-parent-link"
                  title={t('reviewRoom.backToParent')}
                >
                  {t('reviewRoom.parentRoom')}
                </a>
              </>
            )}
          </span>
        </div>
        <div className="review-room-actions">
          <button
            className="review-room-primary"
            onClick={() =>
              onStart({
                kind: nextKind,
                mode: nextKind === 'fix' ? 'parallel' : nextMode,
                participants: nextKind === 'fix' && fixer !== 'auto' ? [fixer] : undefined,
              })
            }
            disabled={busy || anyRunning}
            title={
              anyRunning
                ? t('reviewRoom.roundRunning')
                : nextKind === 'fix'
                  ? t('reviewRoom.startFixTitle', {
                      fixer: fixer === 'auto' ? t('reviewRoom.autoFixer') : labelForAgent(fixer),
                    })
                  : t('reviewRoom.startRoundTitle', {
                      kind: ROUND_KIND_LABEL[nextKind],
                      mode: nextMode === 'serial' ? t('newChat.serial') : t('newChat.parallel'),
                    })
            }
          >
            <Icon name="sparkle" size={14} />
            {anyRunning
              ? t('reviewRoom.inProgress')
              : started
              ? t('reviewRoom.startKind', { kind: ROUND_KIND_LABEL[nextKind] })
              : 'Start Review'}
          </button>
          {manualFixPending && (
            <button
              className="review-room-secondary is-ready"
              onClick={() => onStart({ kind: 'verify', mode: 'parallel' })}
              disabled={busy || anyRunning}
              title={t('manualFix.verifyTitle')}
            >
              <Icon name="check" size={14} />
              {t('manualFix.verifyNow')}
            </button>
          )}
          {!manualFixPending && !isDone && nextKind === 'fix' && started && (
            <button
              className="review-room-secondary"
              onClick={() => onManualFix(true)}
              disabled={busy || anyRunning}
              title={t('manualFix.startTitle')}
            >
              {t('manualFix.start')}
            </button>
          )}
          {isDone ? (
            <button
              className="review-room-secondary"
              onClick={() => onFinish(false)}
              disabled={busy}
              title={t('reviewRoom.reopenTitle')}
            >
              {t('reviewRoom.reopen')}
            </button>
          ) : (
            <button
              className={`review-room-secondary ${summary?.allResolved ? 'is-ready' : ''}`}
              onClick={() => setDoneDialogOpen(true)}
              disabled={busy || !canFinish}
              title={
                anyRunning
                  ? t('reviewRoom.finishBlocked')
                  : summary?.allResolved
                    ? t('reviewRoom.allResolved')
                    : t('reviewRoom.finishTitle')
              }
            >
              <Icon name="check" size={14} />
              {t('reviewRoom.finish')}
            </button>
          )}
        </div>
      </div>
      <div className="review-rounds">
        <div className="review-rounds-head">
          <div className="review-rounds-heading">
            <span className="review-rounds-title">{t('reviewRoom.rounds')}</span>
            <span>{t('reviewRoom.nextRound')}</span>
          </div>
          <div className="review-rounds-controls">
            <div className="review-kind-row review-segmented" role="group" aria-label={t('reviewRoom.nextRound')}>
              {(['review', 'fix', 'verify'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`review-kind-item ${nextKind === k ? 'active' : ''}`}
                  onClick={() => setNextKind(k)}
                  aria-pressed={nextKind === k}
                >
                  {ROUND_KIND_LABEL[k]}
                </button>
              ))}
            </div>
            {nextKind === 'fix' ? (
              // fix 只允许一个 writer,所以这里换成 fixer 选择,而不是并行/接力开关。
              <div className="review-kind-row review-segmented" role="group" aria-label={t('reviewRoom.singleWriter')}>
                <span className="review-control-label" title={t('reviewRoom.singleWriterLabel')}>
                  {t('reviewRoom.singleWriter')}
                </span>
                {(['auto', ...participants] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    className={`review-kind-item ${fixer === f ? 'active' : ''}`}
                    onClick={() => setFixer(f as AgentName | 'auto')}
                    aria-pressed={fixer === f}
                    title={
                      f === 'auto'
                        ? t('reviewRoom.autoFixerHint')
                        : t('reviewRoom.fixerHint', { agent: labelForAgent(f as AgentName) })
                    }
                  >
                    {f === 'auto' ? t('reviewRoom.autoFixer') : labelForAgent(f as AgentName)}
                  </button>
                ))}
              </div>
            ) : (
              <div className="review-kind-row review-segmented" role="group" aria-label={t('newChat.discussionMode')}>
                {(['parallel', 'serial'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`review-kind-item ${nextMode === m ? 'active' : ''}`}
                    onClick={() => setNextMode(m)}
                    aria-pressed={nextMode === m}
                  >
                    {m === 'parallel' ? t('newChat.parallel') : t('newChat.serial')}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        {rounds.length === 0 ? (
          <div className="review-round-row" style={{ gridTemplateColumns: '1fr' }}>
            <span className="review-round-agents">
              {t('reviewRoom.noRounds', {
                agents: (room?.participants ?? ['claude', 'codex']).map(labelForAgent).join(', '),
              })}
            </span>
          </div>
        ) : (
          rounds.map((r, idx) => (
            <div className="review-round-row" key={r.id}>
              <span className={`review-round-status ${r.status}`}>
                {r.status === 'awaiting-user' ? t('manualFix.awaiting') : r.status}
              </span>
              <span className="review-round-agents">
                #{idx + 1} ·{' '}
                {r.mode === 'manual'
                  ? t('manualFix.round')
                  : `${ROUND_KIND_LABEL[r.kind] ?? r.kind} · ${r.mode} · ${r.agents.map(labelForAgent).join(', ')}`}
              </span>
              <span className="review-round-agents">{relativeTs(r.startedAt)}</span>
            </div>
          ))
        )}
      </div>
      {doneDialogOpen && (
        <DoneDialog
          summary={summary}
          initialConclusion={room?.conclusion ?? ''}
          busy={busy}
          onCancel={() => setDoneDialogOpen(false)}
          onConfirm={(conclusion) => {
            setDoneDialogOpen(false)
            onFinish(true, conclusion)
          }}
        />
      )}
    </>
  )
}

function DoneDialog({
  summary,
  initialConclusion,
  busy,
  onCancel,
  onConfirm,
}: {
  summary?: ReviewRoomState['statusSummary']
  initialConclusion: string
  busy: boolean
  onCancel: () => void
  onConfirm: (conclusion: string) => void
}) {
  const { t } = useI18n()
  const [conclusion, setConclusion] = useState(initialConclusion)
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">{t('reviewRoom.doneDialogTitle')}</span>
          <button className="modal-close" onClick={onCancel} aria-label={t('common.close')}>×</button>
        </div>
        <div className="modal-body">
          {summary && summary.total > 0 && (
            <div className="modal-hint">
              {t('reviewRoom.doneSummary', {
                fixed: summary.fixed,
                wontfix: summary.wontfix,
                open: summary.open + summary.needsCheck,
              })}
            </div>
          )}
          <label className="modal-section">
            <span className="modal-label">{t('reviewRoom.conclusion')}</span>
            <textarea
              className="modal-textarea"
              value={conclusion}
              onChange={(e) => setConclusion(e.target.value)}
              placeholder={t('reviewRoom.conclusionPlaceholder')}
              rows={4}
              autoFocus
            />
          </label>
        </div>
        <div className="modal-actions">
          <button className="modal-btn" onClick={onCancel} disabled={busy}>{t('common.cancel')}</button>
          <button className="modal-btn primary" onClick={() => onConfirm(conclusion.trim())} disabled={busy}>
            {t('reviewRoom.finish')}
          </button>
        </div>
      </div>
    </div>
  )
}
