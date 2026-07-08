import type { AgentName, EventEnvelope, NormalizedEvent } from '../loaders/types'
import type { Operation, RunPermissions } from '../permissions/types'

// 新 agent 只能通过实现 ReviewAgent 扩展,不在 UI/server 硬编码二选一(不变量 9/10)。
// 名字沿用 ReviewAgent(review 只是其中一个快捷场景)。

export interface AgentRunInput {
  /** 当前触发消息(本轮用户请求) */
  text: string
  /** 历史上下文(原始 + 已有 follow-up),**不含当前请求**(调用方按 turnId 剔除当前轮,
   *  docs/01 §九);真实 adapter 用 serializeForAgent 处理 */
  contextEvents: EventEnvelope[]
  /** 目标 agent(同一 thread 可逐条切换) */
  targetAgent: AgentName
  cwd: string | null
  /** 默认只读;Phase 3 才放开写 */
  useTools: boolean
  /** run 级权限档位。adapter 必须通过 Cockpit policy 使用副作用能力。 */
  permissions?: RunPermissions
  /** 用户已批准的额外可写目录,用于 Codex/Claude/Cursor 等 CLI 的 add-dir/workspace root 参数。 */
  writableRoots?: string[]
  /** 可选模型覆盖。透传给 CLI 的 --model 参数(alias 或完整 ID)。空 = 用 CLI 默认。 */
  model?: string
  /** 推理强度:claude 走 `--effort <v>`,codex 走 `-c model_reasoning_effort="<v>"`。
   *  实测可用值:claude {low,medium,high,xhigh,max};codex {low,medium,high,xhigh}。 */
  effort?: string
  /** Runtime 发起真实副作用操作时的审批回调。没有回调的 adapter 必须保持只读/安全模式。 */
  requestApproval?: (operation: Operation, reason?: string) => Promise<'approved' | 'rejected'>
  /**
   * Phase 2 opt-in:用户已知悉「本 thread 会通过官方 runtime 产生原生 session 副作用」时,
   * adapter 可以在 provider-thread-link store 里查/建对应 thread,后续轮复用。
   * 未设置时保持默认 ephemeral 行为。目前仅 Codex app-server 消费。
   */
  nativeLinked?: {
    scope:
      | { kind: 'followup'; source: string; sessionId: string; agent: AgentName }
      | { kind: 'group-member'; groupThreadId: string; agent: AgentName }
  }
  signal: AbortSignal
}

export type NativeWriteMode = 'read-only' | 'trusted'

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
  /** Native resume 只有两档:read-only 预览 vs trusted 允许写回。
   *  没有中间"逐工具审批"档 —— CLI headless 接不住 approval,详见 docs/10。
   *  默认 read-only,trusted 必须由用户在 UI 里显式勾选、每次都要重勾。 */
  writeMode: NativeWriteMode
  /** 推理强度:透传给底层 CLI(claude `--effort`、codex `-c model_reasoning_effort`)。
   *  缺省时由路由默认成 `medium`,保证原生续写也能看到 thinking/reasoning 事件。 */
  effort?: string
  signal: AbortSignal
}

export interface ReviewAgent {
  name: AgentName
  /** 检测本机 CLI 是否可用;不可用时路由返回可展示错误 */
  isAvailable(): Promise<boolean>
  /** 可选轻量预热:只能做 CLI/SDK/capability 初始化,不能发模型请求或创建原生 session。 */
  warmup?(): Promise<unknown>
  /** 流式产出 NormalizedEvent(不含 envelope 包装,由路由补 origin/turnId/runId) */
  run(input: AgentRunInput): AsyncIterable<NormalizedEvent>
  /** 是否支持写回对应原生 CLI 会话。只允许同源 session 暴露这个能力。 */
  canResumeNative?(source: string): boolean
  /** 真正 resume 原生 session;输出只用于 SSE,最终事实来源仍是原生 JSONL。 */
  resumeNative?(input: NativeResumeInput): AsyncIterable<NormalizedEvent>
}
