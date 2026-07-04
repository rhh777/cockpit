import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { fetchChanges, fetchRunningRuns, fetchSessionDetail, revealSession, type SessionDetailDTO } from '../lib/api'
import {
  attachRunStream,
  cancelRun,
  fetchActiveRuns,
  subscribeSessionStream,
  startFollowupRun,
  startGroupRun,
  startNativeResumeRun,
  type RunRecord,
  type RunStreamMessage,
} from '../lib/sse'
import { sourceLabel, displayTitle } from '../lib/display'
import { buildTimeline, summarizeTools, type FilterKind, type TraceGroup } from '../lib/timeline'
import type { AgentName, ChatAttachment, EventEnvelope, Source } from '../lib/types'
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

function sessionAgentOf(source: string | undefined): AgentName {
  if (source === 'codex') return 'codex'
  return 'claude' // claude-code 默认 claude;cockpit / 未知一律落到 claude 主线
}

function canNativeResume(source: string | undefined): boolean {
  return source === 'claude-code' || source === 'codex'
}

function isGroupSource(source: string | undefined): boolean {
  return source === 'cockpit'
}

function isServerRunClientId(clientId: string): boolean {
  return clientId.startsWith('run_') || clientId.startsWith('native_run_')
}

export function SessionDetail() {
  const { source, id } = useParams()
  const { width: reviewWidth, onDragStart: onReviewDrag } = useResizable(
    'cockpit.reviewWidth',
    360,
    240,
    700,
    'right',
  )
  const [detail, setDetail] = useState<SessionDetailDTO | null>(null)
  const [events, setEvents] = useState<EventEnvelope[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<FilterKind>('all')
  const [keyword, setKeyword] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(() => readAutoRefreshPreference())
  const [live, setLive] = useState(false)
  const [streams, setStreams] = useState<ActiveStream[]>([])
  const [sendError, setSendError] = useState<string | null>(null)
  const [activeTrace, setActiveTrace] = useState<TraceGroup | null>(null)
  // 客户端 partition 兜底:即便 server 没回写 parentTurnId / 历史 user_text 没 targetAgent,
  // 也能把 child 轮归回旁路 thread。送出请求时就锁定,不依赖 SSE/loader 字段。
  const [clientChainHints, setClientChainHints] = useState<{
    parentOf: Record<string, string>
    agentOf: Record<string, AgentName>
  }>({ parentOf: {}, agentOf: {} })

  const eventsLenRef = useRef(0)
  const seenIds = useRef<Set<string>>(new Set())
  const streamsRef = useRef<ActiveStream[]>([])
  const abortsRef = useRef<Map<string, () => void>>(new Map())
  eventsLenRef.current = events.length
  streamsRef.current = streams

  // 去重追加(不变量 12):按 sourceEventId,无 id 用 seenIds 当前大小兜底。
  // 注意:seenIds 必须在 setState 之外更新——React StrictMode 会把 updater 跑两次,
  // 若在 updater 里 add,第二次跑就把刚追加的事件当成"已见过"丢掉,UI 看似永远收不到。
  const appendEnvelopes = useCallback((incoming: EventEnvelope[]) => {
    if (incoming.length === 0) return
    const fresh: EventEnvelope[] = []
    for (const e of incoming) {
      const k = e.sourceEventId ?? `#${seenIds.current.size}`
      if (seenIds.current.has(k)) continue
      seenIds.current.add(k)
      fresh.push(e)
    }
    if (fresh.length === 0) return
    setEvents((prev) => [...prev, ...fresh])
  }, [])

  const resetFrom = useCallback((d: SessionDetailDTO) => {
    setDetail(d)
    setEvents(d.events)
    seenIds.current = new Set(d.events.map((e, i) => e.sourceEventId ?? `#${i}`))
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
        if (reason === 'error') setSendError(message ?? '请求失败')
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
    [source, id, appendEnvelopes],
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
        if (reason === 'error') setSendError(message ?? '群聊发送失败')
      }

      attachRunStream(
        run.runId,
        (msg: RunStreamMessage) => {
          if (msg.kind === 'meta' && 'groupTurnId' in msg) {
            setStreams((prev) =>
              prev.map((s) => (s.clientId === clientId ? { ...s, turnId: msg.groupTurnId, rootTurnId: msg.groupTurnId } : s)),
            )
          } else if (msg.kind === 'event' && 'groupTurnId' in msg) {
            appendEnvelopes([msg.envelope])
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
    [source, id, appendEnvelopes],
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
        if (reason === 'error') setSendError(message ?? '原生续写失败')
        if (reason === 'done') {
          try {
            const d = await fetchSessionDetail(source, id)
            resetFrom(d)
            setLive(true)
          } catch (e) {
            setSendError(`原生续写已完成,但刷新失败:${String(e)}`)
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
    setEvents([])
    setSendError(null)
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
                else attachFollowupRun(run, undefined)
              }
            })
            .catch(() => {})
        }
      })
      .catch((e) => alive && (setError(String(e)), setLoading(false)))
    return () => {
      alive = false
    }
  }, [source, id, resetFrom, attachFollowupRun, attachGroupRun, attachNativeRun])

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

  // 发一条 follow-up,可能并行发到多个 agent(@-mentions)。
  const handleSend = useCallback(
    (
      text: string,
      agents: AgentName[],
      parentTurnId?: string,
      cli?: { model?: string; effort?: string },
      attachments?: AttachmentDraft[],
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
    (text: string, agents: AgentName[], options?: CliSelection | CliSelectionByAgent, attachments?: AttachmentDraft[]) => {
      if (!id) return
      setSendError(null)
      startGroupRun(
        id,
        {
          text,
          targetAgents: agents,
          useTools: true,
          cliByAgent: options as CliSelectionByAgent | undefined,
          attachments,
        },
      )
        .then(({ records, userEnvelope, turnStart }) => {
          appendEnvelopes([userEnvelope, ...(turnStart ? [turnStart] : [])])
          for (const run of records) attachGroupRun(run)
        })
        .catch((e) => setSendError(String(e)))
    },
    [id, appendEnvelopes, attachGroupRun],
  )

  const handleNativeSend = useCallback(
    (text: string, attachments?: AttachmentDraft[]) => {
      if (!source || !id || !canNativeResume(source)) return
      setSendError(null)
      startNativeResumeRun(source, id, { text, attachments })
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
    for (const abort of abortsRef.current.values()) abort()
  }, [])

  const handleCancelOne = useCallback((clientId: string) => {
    if (isServerRunClientId(clientId)) cancelRun(clientId).catch(() => {})
    abortsRef.current.get(clientId)?.()
  }, [])

  const handleReveal = useCallback(
    (target: 'native' | 'followups') => {
      if (!source || !id) return
      revealSession(source, id, target).catch((e) => setSendError(`Finder 打开失败:${String(e)}`))
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
  const [showFiles, setShowFiles] = useState(false)
  const [viewMode, setViewMode] = useState<'narrative' | 'detail'>('detail')

  if (loading)
    return (
      <div className="detail">
        <div className="empty">加载中…</div>
      </div>
    )
  if (error)
    return (
      <div className="detail">
        <div className="empty">加载失败:{error}</div>
      </div>
    )
  if (!detail) return <div className="detail" />

  const s = detail.summary
  const groupMode = isGroupSource(source)
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
              <AgentIcon source={s.source} size={18} />
            </span>
            <span className="detail-title-text" title={`${s.title}${s.cwd ? `\n${s.cwd}` : ''}`}>
              {displayTitle(s.title)}
            </span>
            <span
              className="detail-event-count"
              title={s.cwd ? `${s.cwd}\n${partitioned.main.length} 个事件` : `${partitioned.main.length} 个事件`}
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
                  ? (live ? '自动刷新 · 实时(点击暂停)' : '自动刷新(点击暂停)')
                  : '自动刷新 · 已暂停(点击恢复)'
              }
              aria-label="切换自动刷新"
            >
              <span className={`refresh-indicator-dot ${autoRefresh && live ? 'live' : ''}`} />
            </button>
            <button
              className="head-icon-btn"
              onClick={() => handleReveal('native')}
              title={groupMode ? '在 Finder 中打开群聊 transcript' : '在 Finder 中打开原始会话文件'}
              aria-label={groupMode ? '在 Finder 中打开群聊 transcript' : '在 Finder 中打开原始会话文件'}
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
          {sendError && <div className="banner warn conversation-banner">发送失败:{sendError}</div>}
          <div className="conversation-bottom">
            <StreamingStatus
              streams={groupMode ? streams : streams.filter((s) => s.agent === sessionAgentOf(source))}
              events={events}
            />
            <FollowupComposer
              key={`${source}:${id}:composer`}
              hasActiveStreams={streams.length > 0}
              sessionAgent={sessionAgentOf(source)}
              nativeAvailable={!groupMode && canNativeResume(source)}
              groupMode={groupMode}
              onSend={(t, a, options, attachments) =>
                groupMode
                  ? handleGroupSend(t, a, options as CliSelectionByAgent | undefined, attachments)
                  : handleSend(t, a, undefined, options as CliSelection | undefined, attachments)
              }
              onNativeSend={handleNativeSend}
              onCancelAll={handleCancelAll}
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
