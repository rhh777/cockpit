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

/** 原生 session 来源 → 可原生续写的 agent;非原生来源(cockpit 群聊等)返回 null。 */
export function nativeAgentForSource(source: string | undefined): 'claude' | 'codex' | 'opencode' | null {
  if (source === 'codex') return 'codex'
  if (source === 'claude-code') return 'claude'
  if (source === 'opencode') return 'opencode'
  return null
}

/** session 主线 agent:原生来源对应 agent;cockpit / 未知一律落到 claude 主线。 */
export function sessionAgentOf(source: string | undefined): AgentName {
  if (source === 'opencode') return 'opencode'
  if (source === 'cursor') return 'cursor'
  return nativeAgentForSource(source) ?? 'claude'
}
