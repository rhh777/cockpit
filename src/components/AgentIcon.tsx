import claudeIcon from '../assets/agent-icons/claude.png'
import cockpitIcon from '../assets/agent-icons/cockpit.png'
import codexIcon from '../assets/agent-icons/codex.png'
import cursorIcon from '../assets/agent-icons/cursor.png'
import opencodeIcon from '../assets/agent-icons/opencode.png'
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
  const src =
    normalized === 'codex'
      ? codexIcon
      : normalized === 'cockpit'
      ? cockpitIcon
      : normalized === 'opencode'
      ? opencodeIcon
      : normalized === 'cursor'
      ? cursorIcon
      : claudeIcon
  const label = normalized === 'cockpit' ? 'Cockpit' : labelForAgent(normalized)

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
