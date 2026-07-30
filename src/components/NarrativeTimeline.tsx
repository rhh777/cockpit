import { useCallback, useMemo, useRef, useState } from 'react'
import type { EventEnvelope } from '../lib/types'
import { buildTimeline, buildTurns, type NarrativeAction, type NarrativeRow, type TraceGroup } from '../lib/timeline'
import { useI18n } from '../lib/i18n'
import type { MessageKey } from '../lib/i18n'
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
  const { t } = useI18n()
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
      {rows.length === 0 && <div className="narrative-empty">{t('narrative.empty')}</div>}
      </div>
      <JumpToBottom visible={!atBottom} hasNew={hasNew} onClick={jumpToBottom} />
    </div>
  )
}

function UserNarrativeRow({ row }: { row: Extract<NarrativeRow, { kind: 'user' }> }) {
  const { t } = useI18n()
  const preview = row.text.replace(/\s+/g, ' ').trim()
  const short = preview.length > 140 ? preview.slice(0, 140) + '…' : preview
  return (
    <div className="narr-row narr-user">
      <span className="narr-avatar narr-avatar-user">{t('narrative.you')}</span>
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
  const { t } = useI18n()
  const { action, preview, metrics, agent, durationMs } = row
  const { verb, object } = describeAction(action, t)
  const label = agent ? agentLabel(agent) : 'assistant'
  const dur = durationMs && durationMs > 800 ? formatDur(durationMs) : ''

  return (
    <div className={`narr-row narr-assistant ${expanded ? 'is-expanded' : ''}`} data-agent={agent}>
      <span className={`narr-avatar narr-avatar-${agent ?? 'assistant'}`}>
        <AgentIcon agent={agent as 'claude' | 'codex' | undefined} size={22} />
      </span>
      <button className="narr-summary" onClick={onToggle} aria-expanded={expanded}>
        <span className="narr-caret">{expanded ? '▾' : '▸'}</span>
        <span className="narr-agent">{label}</span>
        <span className="narr-verb">{verb}</span>
        {object && <span className="narr-object">{object}</span>}
        {preview && action.kind !== 'reply' && (
          <span className="narr-preview" title={preview}>· {preview}</span>
        )}
        <span className="narr-meta">
          {metrics.errors > 0 && (
            <span className="narr-err" title={t('trace.errorCount', { count: metrics.errors })}>● {metrics.errors}</span>
          )}
          {metrics.events > 0 && <span className="narr-count">{t('narrative.eventCount', { count: metrics.events })}</span>}
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
              title={t('narrative.openTrace')}
            >
              <Icon name="wrench" size={11} /> {t('narrative.viewFullTrace')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// NarrativeAction(结构化)→ 显示用的动词 + 宾语。timeline 层不产人类语言,文案只在这里。
function describeAction(
  action: NarrativeAction,
  t: (key: MessageKey, values?: Record<string, string | number>) => string,
): { verb: string; object: string } {
  switch (action.kind) {
    case 'test':
      return { verb: t('verb.runTests'), object: action.failed ? t('verb.testsFailed') : t('verb.testsPassed') }
    case 'read-write':
      return {
        verb: t('verb.readWrite'),
        object: t('verb.readWriteObject', { read: action.read, write: action.write, diff: action.diff }),
      }
    case 'write':
      return { verb: t('verb.write'), object: t('verb.writeObject', { count: action.write, diff: action.diff }) }
    case 'analyze':
      return { verb: t('verb.analyze'), object: t('verb.fileCount', { count: action.read }) }
    case 'review':
      return { verb: t('verb.review'), object: t('verb.fileCount', { count: action.read }) }
    case 'bash':
      return { verb: t('verb.runCommands'), object: t('verb.commandCount', { count: action.count }) }
    case 'think':
      return { verb: t('verb.think'), object: t('verb.stepCount', { count: action.steps }) }
    case 'reply':
      return { verb: t('verb.reply'), object: action.preview }
  }
}

function formatDur(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m${s % 60}s`
}
