import claudeIcon from '../assets/agent-icons/claude.png'
import cockpitIcon from '../assets/agent-icons/cockpit.png'
import codexIcon from '../assets/agent-icons/codex.png'
import type { AgentName, Source } from '../lib/types'

type AgentIconName = 'claude' | 'codex' | 'cockpit'

function normalizeAgent(agent: AgentName | Source | string | undefined): AgentIconName {
  if (agent === 'codex') return 'codex'
  if (agent === 'cockpit' || agent === 'group' || agent === 'group-chat') return 'cockpit'
  return 'claude'
}

export function agentLabel(agent: AgentName | Source | string | undefined): string {
  if (normalizeAgent(agent) === 'cockpit') return 'Cockpit'
  return normalizeAgent(agent) === 'codex' ? 'Codex' : 'Claude'
}

export function AgentIcon({
  agent,
  source,
  size = 18,
  className = '',
}: {
  agent?: AgentName | string
  source?: Source | string
  size?: number
  className?: string
}) {
  const normalized = normalizeAgent(agent ?? source)
  const src = normalized === 'codex' ? codexIcon : normalized === 'cockpit' ? cockpitIcon : claudeIcon
  const label = normalized === 'codex' ? 'Codex' : normalized === 'cockpit' ? 'Cockpit' : 'Claude'

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
