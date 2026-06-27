import type { AgentName } from '../loaders/types'
import { mockAdapter } from './mock-adapter'
import { claudeAdapter } from './claude-call'
import { codexAdapter } from './codex-call'
import type { ReviewAgent } from './types'

// agent 名 → adapter。不在别处硬编码 if (agent==='claude'||agent==='codex')(不变量 9)。
// 新 agent 只加一行注册。未知名落回 mock。
const agents = new Map<AgentName, ReviewAgent>()

export function registerAgent(agent: ReviewAgent) {
  agents.set(agent.name, agent)
}

registerAgent(claudeAdapter)
registerAgent(codexAdapter)

export function resolveAgent(name: AgentName): ReviewAgent {
  return agents.get(name) ?? mockAdapter
}
