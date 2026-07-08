import type { AgentName } from '../loaders/types'
import { mockAdapter } from './mock-adapter'
import { claudeAdapter } from './claude-call'
import { codexAdapter } from './codex-call'
import { cursorAdapter } from './cursor-call'
import { opencodeAdapter } from './opencode-call'
import { setAgentDisplayName } from './agent-meta'
import type { ReviewAgent } from './types'

// agent 名 → adapter。不在别处硬编码 if (agent==='claude'||agent==='codex')(不变量 9)。
// 新 agent 只加一行注册。未知名落回 mock。
// 显示名/能力(displayName / supportsApproval / canResumeNative)挂在 ReviewAgent 上,
// 消费方一律经 registry / agent-meta 取,不各自维护映射(docs/12 D1)。
const agents = new Map<AgentName, ReviewAgent>()

export function registerAgent(agent: ReviewAgent) {
  agents.set(agent.name, agent)
  setAgentDisplayName(agent.name, agent.displayName ?? String(agent.name))
}

registerAgent(claudeAdapter)
registerAgent(codexAdapter)
registerAgent(opencodeAdapter)
registerAgent(cursorAdapter)

export function resolveAgent(name: AgentName): ReviewAgent {
  return agents.get(name) ?? mockAdapter
}

export function listAgents(): ReviewAgent[] {
  return [...agents.values()]
}

/** 原生 session 来源 → 能原生续写它的 agent(canResumeNative 反查);没有则 null。 */
export function agentForNativeSource(source: string): ReviewAgent | null {
  for (const agent of agents.values()) {
    if (agent.canResumeNative?.(source)) return agent
  }
  return null
}
