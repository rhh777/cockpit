import { useEffect, useState } from 'react'
import type { AgentName, EventEnvelope } from '../lib/types'
import { labelForAgent } from '../lib/agents'
import type { RunPhase } from '../lib/sse'
import { useI18n, type MessageKey } from '../lib/i18n'

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string

export interface ActiveStream {
  clientId: string
  agent: AgentName
  turnId?: string
  /** 旁路 thread 的根 turnId(发起时若指定 parentTurnId 即设;否则 meta 到达后落自身 turnId)。 */
  rootTurnId?: string
  startedAt: number
  phase?: RunPhase
}

// icon 固定,文案走 i18n:只存 message key,渲染时用 t() 取。
const PHASE_LABELS: Record<RunPhase, { icon: string; key: MessageKey }> = {
  queued: { icon: '⏳', key: 'phase.queued' },
  warming_runtime: { icon: '⏳', key: 'phase.warmingRuntime' },
  runtime_ready: { icon: '✓', key: 'phase.runtimeReady' },
  building_context: { icon: '🧩', key: 'phase.buildingContext' },
  starting_turn: { icon: '⏳', key: 'phase.startingTurn' },
  streaming: { icon: '✍️', key: 'phase.streaming' },
  waiting_approval: { icon: '⏸', key: 'phase.waitingApproval' },
  completed: { icon: '✓', key: 'phase.completed' },
  failed: { icon: '!', key: 'phase.failed' },
}

function latestActivityForTurn(
  events: EventEnvelope[],
  turnId: string | undefined,
  t: Translate,
): { icon: string; text: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const env = events[i]
    if (turnId && env.turnId !== turnId) continue
    if (!turnId && env.turnId) continue
    const ev = env.event
    if (ev.type === 'thinking') return { icon: '💭', text: t('activity.thinking') }
    if (ev.type === 'tool_use') return { icon: '🔧', text: t('activity.toolUse', { name: ev.name }) }
    if (ev.type === 'tool_result') return { icon: '✓', text: t('activity.toolResult') }
    if (ev.type === 'assistant_text') return { icon: '✍️', text: t('activity.generating') }
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
  const { t } = useI18n()
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
        const act = latestActivityForTurn(events, s.turnId, t)
        const phase = s.phase ? PHASE_LABELS[s.phase] : null
        const headline = act ? act.text : phase ? t(phase.key) : t('activity.connecting')
        const icon = act?.icon ?? phase?.icon ?? '⏳'
        const agentLabel = labelForAgent(s.agent)
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
