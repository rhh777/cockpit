// 统一事件类型 —— Loader 出口 / UI 入口。见 docs/01 §三核心数据模型。
// 这是契约:UI 永不解析原生 Claude/Codex schema,只消费这里的类型(不变量 6)。

export type Source = 'claude-code' | 'codex' | 'cockpit' | (string & {})
export type AgentName = 'claude' | 'codex' | (string & {})
export type Origin = 'native' | 'cockpit'

export interface SessionSummary {
  id: string
  source: Source
  title: string
  cwd: string | null
  startedAt: string
  updatedAt: string
  messageCount: number | null // null = 列表阶段拿不到(如 Codex 只读 index)
  filePath: string // server 内部字段,不当权限凭据用
  fileMtimeMs: number
  fileSize: number
  hasFollowups: boolean
  extensions?: Record<string, unknown>
}

export type ChatAttachment =
  | {
      kind: 'file'
      path: string
      name: string
    }
  | {
      kind: 'directory'
      path: string
      name: string
    }
  | {
      kind: 'image'
      path?: string
      dataUrl?: string
      name: string
      mimeType: string
    }

export type NormalizedEvent =
  | {
      type: 'user_text'
      text: string
      ts: string
      targetAgent?: AgentName
      targetAgents?: AgentName[]
      mentions?: AgentName[]
      parentTurnId?: string
      attachments?: ChatAttachment[]
    }
  | {
      type: 'assistant_text'
      text: string
      ts: string
      agent?: AgentName
      // 流式 delta:同 streamId 的多条 delta 拼接出最终文本;server 不落盘,UI 端 buildTimeline 合并。
      streamId?: string
      delta?: boolean
    }
  | { type: 'thinking'; text: string; ts: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown; ts: string; agent?: AgentName }
  | { type: 'tool_result'; toolUseId: string; output: string; isError: boolean; ts: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; ts: string; agent?: AgentName }
  | { type: 'followup_boundary'; ts: string }
  | { type: 'meta'; key: string; value: unknown; ts: string }

export interface EventEnvelope {
  origin: Origin
  source: Source
  sourceEventId?: string
  parentEventId?: string
  turnId?: string
  runId?: string
  event: NormalizedEvent
}

export interface LoaderWarning {
  line?: number
  code: 'json_parse_failed' | 'unknown_schema' | 'missing_field' | (string & {})
  message: string
}

export interface SessionDetail {
  summary: SessionSummary
  events: EventEnvelope[]
  warnings?: LoaderWarning[]
  raw?: unknown[]
}

// 新 source 只能通过实现这个 interface 扩展,不能在 UI/server 硬编码二选一(不变量 9)。
// 扩展能力只能加可选方法(不变量 10),例如 Phase 3 的 watchSession。
export interface SessionSourceLoader {
  source: Source
  /** discovery 阶段:列出该来源所有 session 摘要,并产出 filePath 供 registry 用 */
  discover(): Promise<{ summaries: SessionSummary[]; warnings: LoaderWarning[] }>
  /** 详情阶段:给定已校验的 filePath,读出原始 events(origin='native') */
  loadEvents(filePath: string): Promise<{
    summaryPatch: Partial<SessionSummary>
    events: EventEnvelope[]
    warnings: LoaderWarning[]
  }>
  /** Phase 3 实时模式预留口子,MVP 不实现 */
  watchSession?(filePath: string): AsyncIterable<EventEnvelope>
}
