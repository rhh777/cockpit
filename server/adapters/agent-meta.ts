// Agent 显示名的 server 侧事实源(docs/12 D1)。零依赖叶子模块:serialize 等底层模块
// 从这里读,registry.registerAgent 在注册时写入,避免 serialize → registry → adapter →
// serialize 的循环导入。未注册的名字回退为原始字符串。
// (前端另有 src/lib/agents.ts 作为 UI 事实源,含图标/顺序等。)

const displayNames = new Map<string, string>()

export function setAgentDisplayName(name: string, displayName: string): void {
  displayNames.set(name, displayName)
}

export function agentDisplayName(name: string | undefined): string {
  if (!name) return 'Assistant'
  return displayNames.get(name) ?? String(name)
}
