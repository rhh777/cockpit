import type { AgentName } from './types'

export const AGENT_OPTIONS: { value: AgentName; label: string }[] = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'cursor', label: 'Cursor' },
]

export function labelForAgent(agent: AgentName | string | undefined): string {
  return AGENT_OPTIONS.find((a) => a.value === agent)?.label ?? String(agent ?? 'Agent')
}

