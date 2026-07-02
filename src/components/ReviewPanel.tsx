import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { AgentName, EventEnvelope } from '../lib/types'
import { buildTimeline, clusterRows, foldGroupsIntoAssistant, summarizeToolNames, type TraceGroup, type ToolPair } from '../lib/timeline'
import { EventItem } from './EventItem'
import { Icon } from './Icon'
import { AgentIcon, agentLabel } from './AgentIcon'

function latestThreadActivity(events: EventEnvelope[]): { icon: string; text: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i].event
    if (ev.type === 'thinking') return { icon: '💭', text: '正在思考…' }
    if (ev.type === 'tool_use') return { icon: '🔧', text: `调用工具 ${ev.name}…` }
    if (ev.type === 'tool_result') return { icon: '✓', text: '工具返回,继续处理…' }
    if (ev.type === 'assistant_text') {
      const tail = ev.text.slice(-40).replace(/\s+/g, ' ').trim()
      return { icon: '✍️', text: tail ? `生成中:…${tail}` : '正在生成回复…' }
    }
    if (ev.type === 'user_text') break
  }
  return null
}

export interface ReviewThread {
  turnId: string
  agent: AgentName
  events: EventEnvelope[]
}

export interface PendingStream {
  clientId: string
  agent: AgentName
  turnId?: string
  rootTurnId?: string
}

// 右侧旁路栏:每个旁路 agent 的整条 thread(根 turn + 同 root 的所有后续 turn)单独成卡,
// 卡底自带 mini composer,可继续与该 agent 讨论 review 结论,不污染主 timeline。
export function ReviewPanel({
  style,
  threads,
  pending,
  onCancel,
  onReply,
  onViewTrace,
  onReveal,
}: {
  style?: CSSProperties
  threads: ReviewThread[]
  pending: PendingStream[]
  onCancel?: (clientId: string) => void
  onReply?: (rootTurnId: string, agent: AgentName, text: string) => void
  onViewTrace?: (group: TraceGroup) => void
  onReveal?: () => void
}) {
  // 已有 rootTurnId 的 pending 不再单独显示:其 spinner / 事件归到对应 thread 卡。
  const orphans = pending.filter(
    (p) => !threads.some((t) => t.turnId === (p.rootTurnId ?? p.turnId)),
  )

  // 当前选中的 thread(默认最后一个,即最新活跃的)
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null)
  useEffect(() => {
    if (threads.length === 0) {
      setActiveTurnId(null)
    } else if (!activeTurnId || !threads.some((t) => t.turnId === activeTurnId)) {
      setActiveTurnId(threads[threads.length - 1].turnId)
    }
  }, [threads, activeTurnId])

  if (threads.length === 0 && orphans.length === 0) return null

  const activeThread = threads.find((t) => t.turnId === activeTurnId)
  const activeStreaming = activeThread
    ? pending.find((p) => (p.rootTurnId ?? p.turnId) === activeThread.turnId)
    : undefined

  const headAgent: AgentName | undefined =
    activeThread?.agent ?? threads[0]?.agent ?? orphans[0]?.agent
  return (
    <aside className="review-panel" style={style}>
      <div className={`review-head ${headAgent ? `tinted-${headAgent}` : ''}`}>
        {headAgent && (
          <span className={`badge ${headAgent === 'codex' ? 'codex' : 'claude-code'} badge-icon`}>
            <AgentIcon agent={headAgent} size={18} />
          </span>
        )}
        <span className="review-head-title"><Icon name="arrow-up-right" size={12} /> 旁路 {agentLabel(headAgent)}</span>
        <span className="review-count">{threads.length + orphans.length}</span>
        <span className="review-head-spacer" />
        {activeThread ? (
          <span className="review-head-meta">
            {activeThread.events.length} 事件
          </span>
        ) : (
          <span className="subhead-muted">尚无 review</span>
        )}
        {onReveal && (
          <button
            className="head-icon-btn"
            onClick={onReveal}
            title="在 Finder 中打开旁路记录"
            aria-label="在 Finder 中打开旁路记录"
          >
            <Icon name="folder" size={13} />
          </button>
        )}
      </div>
      <div className="review-list">
        {threads.map((t) => {
          const streamingPending = pending.find(
            (p) => (p.rootTurnId ?? p.turnId) === t.turnId,
          )
          return (
            <ReviewThreadView
              key={t.turnId}
              thread={t}
              streaming={Boolean(streamingPending)}
              active={t.turnId === activeTurnId}
              onSelect={() => setActiveTurnId(t.turnId)}
              onCancel={
                onCancel && streamingPending
                  ? () => onCancel(streamingPending.clientId)
                  : undefined
              }
              onViewTrace={onViewTrace}
              onReveal={onReveal}
            />
          )
        })}
        {orphans.map((p) => (
          <div key={p.clientId} className="review-thread" data-agent={p.agent}>
            <div className="review-thread-head">
              <span className={`avatar ${p.agent}`}><AgentIcon agent={p.agent} size={20} /></span>
              <span className="review-agent-name">{agentLabel(p.agent)}</span>
              <span className="spinner" style={{ marginLeft: 'auto' }} />
              {onCancel && (
                <button className="filter-btn" onClick={() => onCancel(p.clientId)}>
                  取消
                </button>
              )}
              {onReveal && (
                <button
                  className="head-icon-btn"
                  onClick={(e) => { e.stopPropagation(); onReveal() }}
                  title="在 Finder 中打开旁路记录"
                  aria-label="在 Finder 中打开旁路记录"
                >
                  <Icon name="folder" size={13} />
                </button>
              )}
            </div>
            <div className="review-thread-body">
              <div className="empty-mini">正在连接 {agentLabel(p.agent)}…</div>
            </div>
          </div>
        ))}
      </div>
      {activeThread && onReply && (
        <ReviewReplyComposer
          agent={activeThread.agent}
          disabled={Boolean(activeStreaming)}
          streaming={Boolean(activeStreaming)}
          onCancel={
            onCancel && activeStreaming
              ? () => onCancel(activeStreaming.clientId)
              : undefined
          }
          onSend={(text) => onReply(activeThread.turnId, activeThread.agent, text)}
        />
      )}
    </aside>
  )
}

function ReviewThreadView({
  thread,
  streaming,
  active,
  onSelect,
  onCancel,
  onViewTrace,
  onReveal,
}: {
  thread: ReviewThread
  streaming: boolean
  active: boolean
  onSelect: () => void
  onCancel?: () => void
  onViewTrace?: (group: TraceGroup) => void
  onReveal?: () => void
}) {
  const rows = useMemo<
    Array<{ envelope: EventEnvelope; pair?: ToolPair; group?: TraceGroup; precedingGroup?: TraceGroup }>
  >(() => foldGroupsIntoAssistant(clusterRows(buildTimeline(thread.events).rows)), [thread.events])
  const latestAssistantIndex = useMemo(() => {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (!rows[i].group && rows[i].envelope.event.type === 'assistant_text') return i
    }
    return -1
  }, [rows])
  const activity = streaming ? latestThreadActivity(thread.events) : null

  // streaming 时把 body 滚到底,让新事件贴在 composer 上方,不必手动追。
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!streaming) return
    const el = bodyRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [streaming, thread.events.length])

  return (
    <div
      className={`review-thread ${active ? 'review-thread-active' : 'review-thread-collapsed'} ${streaming ? 'streaming' : ''}`}
      data-agent={thread.agent}
      onClick={active ? undefined : onSelect}
    >
      <div className="review-thread-head">
        <span className={`avatar ${thread.agent}`}><AgentIcon agent={thread.agent} size={20} /></span>
        <span className="review-agent-name">{agentLabel(thread.agent)}</span>
        {streaming && <span className="spinner" style={{ marginLeft: 'auto' }} />}
        {streaming && onCancel && (
          <button className="filter-btn" onClick={(e) => { e.stopPropagation(); onCancel() }}>
            取消
          </button>
        )}
        {onReveal && (
          <button
            className="head-icon-btn"
            onClick={(e) => { e.stopPropagation(); onReveal() }}
            title="在 Finder 中打开旁路记录"
            aria-label="在 Finder 中打开旁路记录"
          >
            <Icon name="folder" size={13} />
          </button>
        )}
      </div>
      {active && (
        <div className="review-thread-body" ref={bodyRef}>
          {rows.map((r, i) => (
            r.group ? (
              <ReviewTracePill key={i} group={r.group} onViewTrace={onViewTrace} />
            ) : (
              <EventItem
                key={i}
                envelope={r.envelope}
                pair={r.pair}
                precedingGroup={r.precedingGroup}
                onViewTrace={onViewTrace}
                actionVisibility={i === latestAssistantIndex ? 'visible' : 'hover'}
              />
            )
          ))}
          {streaming && (
            <div className="review-streaming-status" data-agent={thread.agent}>
              <span className="spinner" />
              <span className="review-streaming-icon">{activity?.icon ?? '⏳'}</span>
              <span className="review-streaming-text">
                {activity?.text ?? `等待 ${thread.agent} 开始…`}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ReviewTracePill({
  group,
  onViewTrace,
}: {
  group: TraceGroup
  onViewTrace?: (group: TraceGroup) => void
}) {
  return (
    <button
      className="grouped-trace-pill review-trace-pill"
      onClick={(e) => {
        e.stopPropagation()
        onViewTrace?.(group)
      }}
      title="点击查看运行细节"
    >
      <div className="trace-summary-info">
        {group.thinkingCount > 0 && (
          <span className="trace-stat" title={`${group.thinkingCount} 次思考`}>
            <Icon name="bulb" size={11} />
            {group.thinkingCount > 1 && group.thinkingCount}
          </span>
        )}
        {summarizeToolNames(group).map((name, idx) => (
          <span key={idx} className="trace-stat trace-tool">
            <Icon name="wrench" size={11} /> {name}
          </span>
        ))}
        {group.errorCount > 0 && (
          <span className="trace-stat danger" title={`${group.errorCount} 个错误`}>
            <Icon name="close" size={11} /> {group.errorCount}
          </span>
        )}
      </div>
      <span className="view-trace-hint">查看 →</span>
    </button>
  )
}

function ReviewReplyComposer({
  agent,
  disabled,
  streaming,
  onCancel,
  onSend,
}: {
  agent: AgentName
  disabled: boolean
  streaming: boolean
  onCancel?: () => void
  onSend: (text: string) => void
}) {
  const [text, setText] = useState('')
  const label = agentLabel(agent)
  const send = () => {
    const t = text.trim()
    if (!t || disabled) return
    onSend(t)
    setText('')
  }
  return (
    <div className="review-reply">
      <div className="composer-controls">
        <span className={`native-agent-pill agent-${agent}`}><AgentIcon agent={agent} size={16} /> {label}</span>
        <span className="send-mode-item static" title={`只发给 ${label},不影响主 timeline`}>
          <Icon name="arrow-up-right" size={12} />
          <span>只读旁路</span>
        </span>
      </div>
      <div className="composer-input-wrap group-composer-shell">
        <textarea
          className="review-reply-input composer-input"
          placeholder={
            disabled ? `等待 ${label} 回复…` : `继续追问 ${label} 的 review 结论…(Cmd+Enter)`
          }
          value={text}
          rows={2}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            const composing = (e.nativeEvent as KeyboardEvent).isComposing
            if (e.key === 'Enter' && !e.altKey && !e.shiftKey && !composing) {
              e.preventDefault()
              send()
            }
          }}
        />
        <div className="composer-action-bar">
          <div className="composer-action-left" />
          <button
            className={`send-btn primary-action ${streaming ? 'is-canceling' : 'is-ready'}`}
            onClick={streaming ? onCancel : send}
            disabled={streaming ? !onCancel : disabled || !text.trim()}
            title={
              streaming
                ? `取消 ${label} 当前回复`
                : `只发给 ${label},不写回主 timeline; Enter 发送, Alt+Enter 换行`
            }
            aria-label={streaming ? '取消回复' : '发送回复'}
          >
            {streaming ? (
              <>
                <span className="send-pulse" aria-hidden />
                <Icon name="close" size={14} />
              </>
            ) : (
              <Icon name="send" size={14} />
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
