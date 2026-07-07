import claudeIcon from '../assets/agent-icons/claude.png'
import cockpitIcon from '../assets/agent-icons/cockpit.png'
import codexIcon from '../assets/agent-icons/codex.png'
import { labelForAgent } from '../lib/agents'
import type { AgentName, Source } from '../lib/types'

type AgentIconName = 'claude' | 'codex' | 'opencode' | 'cursor' | 'cockpit'

function normalizeAgent(agent: AgentName | Source | string | undefined): AgentIconName {
  if (agent === 'codex') return 'codex'
  if (agent === 'opencode') return 'opencode'
  if (agent === 'cursor') return 'cursor'
  if (agent === 'cockpit' || agent === 'group' || agent === 'group-chat') return 'cockpit'
  return 'claude'
}

export function agentLabel(agent: AgentName | Source | string | undefined): string {
  if (normalizeAgent(agent) === 'cockpit') return 'Cockpit'
  return labelForAgent(normalizeAgent(agent))
}

export function AgentIcon({
  agent,
  source,
  size = 25,
  className = '',
}: {
  agent?: AgentName | string
  source?: Source | string
  size?: number
  className?: string
}) {
  const normalized = normalizeAgent(agent ?? source)
  const src = normalized === 'codex' ? codexIcon : normalized === 'cockpit' ? cockpitIcon : claudeIcon
  const label = normalized === 'cockpit' ? 'Cockpit' : labelForAgent(normalized)

  if (normalized === 'opencode' || normalized === 'cursor') {
    return (
      <span
        className={`agent-icon agent-icon-${normalized} agent-icon-letter ${className}`.trim()}
        aria-hidden
        title={label}
        style={{ width: size, height: size, fontSize: Math.max(10, Math.floor(size * 0.58)) }}
      >
        {normalized === 'opencode' ? 'O' : 'Cu'}
      </span>
    )
  }

  return (
    <img
      className={`agent-icon agent-icon-${normalized} ${className}`.trim()}
      src={src}
      alt=""
      aria-hidden
      width={size}
      height={size}
      title={label}
    />
  )
}
