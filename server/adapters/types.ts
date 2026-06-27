import type { AgentName, EventEnvelope, NormalizedEvent } from '../loaders/types'

// 新 agent 只能通过实现 ReviewAgent 扩展,不在 UI/server 硬编码二选一(不变量 9/10)。
// 名字沿用 ReviewAgent(review 只是其中一个快捷场景)。

export interface AgentRunInput {
  /** 当前触发消息(本轮用户请求) */
  text: string
  /** 完整合并上下文(原始 + 已有 follow-up),真实 adapter 用 serializeForAgent 处理 */
  contextEvents: EventEnvelope[]
  /** 目标 agent(同一 thread 可逐条切换) */
  targetAgent: AgentName
  cwd: string | null
  /** 默认只读;Phase 3 才放开写 */
  useTools: boolean
  /** 可选模型覆盖。透传给 CLI 的 --model 参数(alias 或完整 ID)。空 = 用 CLI 默认。 */
  model?: string
  /** 推理强度:claude 走 `--effort <v>`,codex 走 `-c model_reasoning_effort="<v>"`。
   *  实测可用值:claude {low,medium,high,xhigh,max};codex {low,medium,high,xhigh}。 */
  effort?: string
  signal: AbortSignal
}

export interface NativeResumeInput {
  /** 当前触发消息(本轮用户请求) */
  text: string
  /** 原生 session 来源,用于 adapter 做同源约束 */
  source: string
  /** 原生 CLI session id */
  sessionId: string
  /** 已校验的原生 JSONL 路径,用于后续审计/扩展;adapter 不直接写它 */
  filePath: string
  cwd: string | null
  signal: AbortSignal
}

export interface ReviewAgent {
  name: AgentName
  /** 检测本机 CLI 是否可用;不可用时路由返回可展示错误 */
  isAvailable(): Promise<boolean>
  /** 流式产出 NormalizedEvent(不含 envelope 包装,由路由补 origin/turnId/runId) */
  run(input: AgentRunInput): AsyncIterable<NormalizedEvent>
  /** 是否支持写回对应原生 CLI 会话。只允许同源 session 暴露这个能力。 */
  canResumeNative?(source: string): boolean
  /** 真正 resume 原生 session;输出只用于 SSE,最终事实来源仍是原生 JSONL。 */
  resumeNative?(input: NativeResumeInput): AsyncIterable<NormalizedEvent>
}
