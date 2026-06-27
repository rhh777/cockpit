import { useEffect, useState } from 'react'
import type { AgentName, EventEnvelope } from '../lib/types'

export interface ActiveStream {
  clientId: string
  agent: AgentName
  turnId?: string
  /** 旁路 thread 的根 turnId(发起时若指定 parentTurnId 即设;否则 meta 到达后落自身 turnId)。 */
  rootTurnId?: string
  startedAt: number
}

function latestActivityForTurn(
  events: EventEnvelope[],
  turnId: string | undefined,
): { icon: string; text: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const env = events[i]
    if (turnId && env.turnId !== turnId) continue
    if (!turnId && env.turnId) continue
    const ev = env.event
    if (ev.type === 'thinking') return { icon: '💭', text: '正在思考…' }
    if (ev.type === 'tool_use') return { icon: '🔧', text: `调用工具 ${ev.name}…` }
    if (ev.type === 'tool_result') return { icon: '✓', text: '工具返回,继续处理…' }
    if (ev.type === 'assistant_text') return { icon: '✍️', text: '正在生成回复…' }
    if (ev.type === 'user_text') return null
  }
  return null
}

export function StreamingStatus({
  streams,
  events,
}: {
  streams: ActiveStream[]
  events: EventEnvelope[]
}) {
  // 每 200ms 重渲一次驱动 elapsed 数字。
  const [, setTick] = useState(0)
  useEffect(() => {
    if (streams.length === 0) return
    const t = setInterval(() => setTick((x) => x + 1), 200)
    return () => clearInterval(t)
  }, [streams.length])

  if (streams.length === 0) return null

  return (
    <div className="streaming-status-list">
      {streams.map((s) => {
        const act = latestActivityForTurn(events, s.turnId)
        const headline = act ? act.text : '正在连接 agent…'
        const icon = act?.icon ?? '⏳'
        const agentLabel = s.agent === 'claude' ? 'Claude' : s.agent === 'codex' ? 'Codex' : s.agent
        const elapsed = Math.max(0, Math.floor((Date.now() - s.startedAt) / 1000))
        return (
          <div key={s.clientId} className="streaming-status" data-agent={s.agent}>
            <span className="spinner" aria-hidden />
            <span className="streaming-icon">{icon}</span>
            <span className={`streaming-agent agent-${s.agent}`}>{agentLabel}</span>
            <span className="streaming-text">{headline}</span>
            <span className="streaming-elapsed">{elapsed}s</span>
          </div>
        )
      })}
    </div>
  )
}
