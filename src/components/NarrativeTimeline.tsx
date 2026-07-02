import { useCallback, useMemo, useRef, useState } from 'react'
import type { EventEnvelope } from '../lib/types'
import { buildTimeline, buildTurns, type NarrativeRow, type TraceGroup } from '../lib/timeline'
import { EventItem } from './EventItem'
import { AgentIcon, agentLabel } from './AgentIcon'
import { Icon } from './Icon'
import { useStickToBottom } from '../hooks/useStickToBottom'
import { JumpToBottom } from './JumpToBottom'

// 视图 A · 叙事线
// 每 turn 一行,一句话说明 AI 做了什么。点开展开 → 还原完整详细事件流。
// 目的:review 时 10 秒扫完一个 session。
export function NarrativeTimeline({
  events,
  onViewTrace,
}: {
  events: EventEnvelope[]
  onViewTrace?: (group: TraceGroup) => void
}) {
  const rows = useMemo<NarrativeRow[]>(
    () => buildTurns(buildTimeline(events).rows),
    [events],
  )
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // 实时追加跟随 + 「新消息」按钮(与 EventTimeline 共用)。用 events.length 当增长信号:
  // 叙事视图一个 turn 折成一行,单轮内的流式更新未必增加行数,用原始事件数更可靠。
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollToEnd = useCallback(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])
  const { atBottom, hasNew, onScroll, jumpToBottom } = useStickToBottom(scrollRef, events.length, scrollToEnd)

  return (
    <div className="timeline-wrap">
      <div className="narrative-timeline" ref={scrollRef} onScroll={onScroll}>
      {rows.map((row) =>
        row.kind === 'boundary' ? (
          <div key={row.key} className="followup-divider">✦ Cockpit follow-up</div>
        ) : row.kind === 'user' ? (
          <UserNarrativeRow key={row.key} row={row} />
        ) : (
          <AssistantNarrativeRow
            key={row.key}
            row={row}
            expanded={expanded.has(row.key)}
            onToggle={() =>
              setExpanded((prev) => {
                const next = new Set(prev)
                if (next.has(row.key)) next.delete(row.key)
                else next.add(row.key)
                return next
              })
            }
            onViewTrace={onViewTrace}
          />
        ),
      )}
      {rows.length === 0 && <div className="narrative-empty">还没有事件</div>}
      </div>
      <JumpToBottom visible={!atBottom} hasNew={hasNew} onClick={jumpToBottom} />
    </div>
  )
}

function UserNarrativeRow({ row }: { row: Extract<NarrativeRow, { kind: 'user' }> }) {
  const preview = row.text.replace(/\s+/g, ' ').trim()
  const short = preview.length > 140 ? preview.slice(0, 140) + '…' : preview
  return (
    <div className="narr-row narr-user">
      <span className="narr-avatar narr-avatar-user">你</span>
      <div className="narr-body">
        <div className="narr-text">{short}</div>
      </div>
    </div>
  )
}

function AssistantNarrativeRow({
  row,
  expanded,
  onToggle,
  onViewTrace,
}: {
  row: Extract<NarrativeRow, { kind: 'assistant' }>
  expanded: boolean
  onToggle: () => void
  onViewTrace?: (group: TraceGroup) => void
}) {
  const { verb, object, preview, metrics, agent, durationMs } = row
  const label = agent ? agentLabel(agent) : 'assistant'
  const dur = durationMs && durationMs > 800 ? formatDur(durationMs) : ''

  return (
    <div className={`narr-row narr-assistant ${expanded ? 'is-expanded' : ''}`} data-agent={agent}>
      <span className={`narr-avatar narr-avatar-${agent ?? 'assistant'}`}>
        <AgentIcon agent={agent as 'claude' | 'codex' | undefined} size={16} />
      </span>
      <button className="narr-summary" onClick={onToggle} aria-expanded={expanded}>
        <span className="narr-caret">{expanded ? '▾' : '▸'}</span>
        <span className="narr-agent">{label}</span>
        <span className="narr-verb">{verb}</span>
        {object && <span className="narr-object">{object}</span>}
        {preview && verb !== '回复' && (
          <span className="narr-preview" title={preview}>· {preview}</span>
        )}
        <span className="narr-meta">
          {metrics.errors > 0 && <span className="narr-err" title={`${metrics.errors} 个错误`}>● {metrics.errors}</span>}
          {metrics.events > 0 && <span className="narr-count">{metrics.events} 事件</span>}
          {dur && <span className="narr-dur">{dur}</span>}
        </span>
      </button>

      {expanded && (
        <div className="narr-detail">
          {row.events.map((item, i) => (
            <EventItem key={i} envelope={item.envelope} pair={item.pair} actionVisibility="visible" />
          ))}
          {metrics.thinkingCount + metrics.reads + metrics.writes + metrics.bashCount > 0 && onViewTrace && (
            <button
              className="narr-trace-btn"
              onClick={() =>
                onViewTrace({
                  type: 'trace_group',
                  turnId: row.turnId ?? '',
                  events: row.events,
                  thinkingCount: metrics.thinkingCount,
                  callCount: metrics.reads + metrics.writes + metrics.bashCount,
                  errorCount: metrics.errors,
                })
              }
              title="打开轨迹抽屉"
            >
              <Icon name="wrench" size={11} /> 查看完整轨迹
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function formatDur(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m${s % 60}s`
}
