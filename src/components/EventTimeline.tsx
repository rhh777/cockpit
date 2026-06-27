import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { EventEnvelope } from '../lib/types'
import { buildTimeline, rowMatchesFilter, clusterRows, summarizeToolNames, type FilterKind, type TraceGroup, type ToolPair } from '../lib/timeline'
import { EventItem } from './EventItem'
import { Icon } from './Icon'

// 灰白分段 + 虚拟化(docs/05 §4.3,不变量:timeline 必虚拟化)。
export function EventTimeline({
  events,
  filter,
  keyword,
  streaming = false,
  onViewTrace,
}: {
  events: EventEnvelope[]
  filter: FilterKind
  keyword: string
  streaming?: boolean
  onViewTrace?: (group: TraceGroup) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  // 用 session 标识(首条事件 id)而不是布尔 flag,避免 StrictMode 第二次 mount 被跳过。
  const lastSessionKey = useRef<string>('')

  const rows = useMemo<Array<{ envelope: EventEnvelope; pair?: ToolPair; group?: TraceGroup }>>(() => {
    const model = buildTimeline(events)
    if (filter === 'all' && !keyword.trim()) return clusterRows(model.rows)
    return model.rows.filter(
      (r) => r.envelope.event.type === 'followup_boundary' || rowMatchesFilter(r, filter, keyword),
    )
  }, [events, filter, keyword])

  const latestAssistantIndex = useMemo(() => {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (!('group' in rows[i]) && rows[i].envelope.event.type === 'assistant_text') return i
    }
    return -1
  }, [rows])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 60,
    overscan: 12,
  })

  // 默认滚到底:首次有数据后滚到最末一条(更符合直觉,docs/05 §4.3 也建议)。
  // 虚拟列表的总高度会随测量逐步增大,所以连续几帧都把 scrollTop 钉到底,直到稳定。
  // 用首条事件 id 当 session key,避免 StrictMode 第二次 mount 时被布尔 flag 跳过。
  const firstKey = rows[0]?.envelope.sourceEventId ?? ''
  useLayoutEffect(() => {
    if (rows.length === 0 || !firstKey) return
    if (lastSessionKey.current === firstKey) return
    lastSessionKey.current = firstKey
    const el = scrollRef.current
    if (!el) return
    let prev = -1
    let stable = 0
    let frames = 0
    // 用 setTimeout 而不是 requestAnimationFrame —— 后者在后台 tab/无头浏览器里会被卡住。
    // 同样不能把 scrollHeight 还是 0(viewport 还没建立、内容还没布局)算作"稳定";
    // 必须等到出现真实高度后再开始计数,否则会被前几帧的 0 假象提前 bail out。
    const step = () => {
      const node = scrollRef.current
      if (!node) return
      const cur = node.scrollHeight
      node.scrollTop = cur
      if (cur > 0 && cur === prev) stable++
      else stable = 0
      prev = cur
      frames++
      if (stable < 5 && frames < 200) setTimeout(step, 16)
    }
    step()
  }, [firstKey, rows.length])

  // streaming 时跟随:新事件追加 → 自动滚到底(若用户已经在底部附近)。
  const lastLenRef = useRef(rows.length)
  useEffect(() => {
    if (!streaming) {
      lastLenRef.current = rows.length
      return
    }
    if (rows.length > lastLenRef.current) {
      const el = scrollRef.current
      const nearBottom =
        !el || el.scrollHeight - el.scrollTop - el.clientHeight < 200
      if (nearBottom) virtualizer.scrollToIndex(rows.length - 1, { align: 'end' })
      lastLenRef.current = rows.length
    }
  }, [rows.length, streaming, virtualizer])

  return (
    <div className="timeline" ref={scrollRef}>
      <div className="timeline-inner" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const row = rows[vi.index]
          const isGroup = 'group' in row && row.group !== undefined
          const ev = !isGroup ? row.envelope.event : null
          const isCockpit = !isGroup ? row.envelope.origin === 'cockpit' : false
          return (
            <div
              key={vi.key}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              className={isGroup ? 'seg-native' : isCockpit ? 'seg-cockpit' : 'seg-native'}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vi.start}px)`,
              }}
            >
              {isGroup ? (
                <button
                  className="grouped-trace-pill"
                  onClick={() => onViewTrace?.(row.group!)}
                  title="点击查看运行细节"
                >
                  <div className="trace-summary-info">
                    {row.group!.thinkingCount > 0 && (
                      <span className="trace-stat" title={`${row.group!.thinkingCount} 次思考`}>
                        <Icon name="bulb" size={11} />
                        {row.group!.thinkingCount > 1 && row.group!.thinkingCount}
                      </span>
                    )}
                    {summarizeToolNames(row.group!).map((name, idx) => (
                      <span key={idx} className="trace-stat trace-tool">
                        <Icon name="wrench" size={11} /> {name}
                      </span>
                    ))}
                    {row.group!.errorCount > 0 && (
                      <span className="trace-stat danger" title={`${row.group!.errorCount} 个错误`}>
                        <Icon name="close" size={11} /> {row.group!.errorCount}
                      </span>
                    )}
                  </div>
                  <span className="view-trace-hint">查看 →</span>
                </button>
              ) : ev && ev.type === 'followup_boundary' ? (
                <div className="followup-divider">✦ Cockpit follow-up</div>
              ) : (
                <EventItem
                  envelope={row.envelope}
                  pair={row.pair}
                  actionVisibility={vi.index === latestAssistantIndex ? 'visible' : 'hover'}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
