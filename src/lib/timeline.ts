import type { EventEnvelope, NormalizedEvent } from './types'

// 噪音事件:对用户没有阅读价值,直接从 timeline 剔除(不进虚拟列表槽位)。
//   - Claude:JSONL 顶层 type 在 normalizeClaudeLine 兜底成 meta(mode/permission-mode/file-history-snapshot/summary/system)
//   - Codex:rollout 里这些事件除了 turn_status 之外都没法读
//   - usage 0/0:流式早期常常是 0/0,纯噪音
const META_NOISE_KEYS = new Set([
  'mode',
  'permission-mode',
  'file-history-snapshot',
  'summary',
  'system',
  'task_started',
  'task_complete',
  'turn_aborted',
  'unknown',
  // attachment 是 Claude 注入给模型的上下文增量(mcp_instructions_delta、todo_reminder 等),
  // EventItem 也会返回 null,但若让它进入 rows 会在两次 tool_use 中间插入隐形槽位,把 trace 群组打断。
  'attachment',
])

export function isNoiseEvent(env: EventEnvelope): boolean {
  const ev = env.event
  if (ev.type === 'meta' && ev.key !== 'turn_status' && META_NOISE_KEYS.has(ev.key)) return true
  // usage 一律不在 timeline 里单独展示:每步都有一条 pill 太啰嗦。
  // ToolActivityBar / 顶部摘要可以提供总量,这里直接隐藏。
  if (ev.type === 'usage') return true
  return false
}

// tool_use / tool_result 按 id 配对(数据层一次,summary 与 timeline 复用,docs/01 §十一)。
export interface ToolPair {
  use: Extract<NormalizedEvent, { type: 'tool_use' }>
  useEnvelope: EventEnvelope
  result?: Extract<NormalizedEvent, { type: 'tool_result' }>
}

export interface TimelineModel {
  // 渲染单元:除 tool_result 外的每个事件;tool_use 携带配对的 result。
  rows: Array<{ envelope: EventEnvelope; pair?: ToolPair }>
  pairs: ToolPair[]
}

export function buildTimeline(events: EventEnvelope[]): TimelineModel {
  const resultByToolId = new Map<string, Extract<NormalizedEvent, { type: 'tool_result' }>>()
  // 哪些 streamId 已有终态 assistant_text 到达:同 streamId 的 delta 全部丢弃,改用终态那条。
  // Claude CLI 偶尔不会给出能稳定对应到最终 assistant message 的 streamId;下面的文本匹配
  // 是兜底,避免运行中先显示 delta,随后又显示最终整段,刷新后才恢复正常。
  const finalizedStreamIds = new Set<string>()
  const finalTextByTurnKey = new Map<string, string>()
  const deltaTextByStreamId = new Map<string, string>()
  const streamTurnKey = new Map<string, string>()
  const assistantTurnKey = (e: EventEnvelope): string | null => {
    const ev = e.event
    if (ev.type !== 'assistant_text' || !e.turnId) return null
    return `${e.turnId}:${e.runId ?? ''}:${ev.agent ?? ''}`
  }
  for (const e of events) {
    if (e.event.type === 'tool_result') {
      resultByToolId.set(e.event.toolUseId, e.event)
    } else if (
      e.event.type === 'assistant_text' &&
      !e.event.delta
    ) {
      if (e.event.streamId) finalizedStreamIds.add(e.event.streamId)
      const turnKey = assistantTurnKey(e)
      if (turnKey) finalTextByTurnKey.set(turnKey, (finalTextByTurnKey.get(turnKey) ?? '') + e.event.text)
    } else if (e.event.type === 'assistant_text' && e.event.delta && e.event.streamId) {
      deltaTextByStreamId.set(
        e.event.streamId,
        (deltaTextByStreamId.get(e.event.streamId) ?? '') + e.event.text,
      )
      const turnKey = assistantTurnKey(e)
      if (turnKey) streamTurnKey.set(e.event.streamId, turnKey)
    }
  }

  const rows: TimelineModel['rows'] = []
  const pairs: ToolPair[] = []
  // 同 streamId 的 delta 合并为一条流式 assistant_text 行:占用 rows 里同一个槽,文本随
  // delta 增长。第一条 delta 出现时插入占位行,后续 delta 把它的文本接长。
  const deltaRowIndex = new Map<string, number>()
  for (const e of events) {
    const ev = e.event
    if (ev.type === 'tool_result') continue // 折进配对的 tool_use 卡
    if (isNoiseEvent(e)) continue // 不让噪音事件占用虚拟列表槽位
    if (ev.type === 'assistant_text' && ev.delta && ev.streamId) {
      const turnKey = streamTurnKey.get(ev.streamId)
      const finalText = turnKey ? finalTextByTurnKey.get(turnKey) : undefined
      const deltaText = deltaTextByStreamId.get(ev.streamId) ?? ''
      if (
        finalizedStreamIds.has(ev.streamId) ||
        (deltaText.length > 0 && finalText?.includes(deltaText))
      ) {
        continue // 终态已到,丢弃 delta
      }
      const existing = deltaRowIndex.get(ev.streamId)
      if (existing != null) {
        const prev = rows[existing].envelope
        const prevEv = prev.event as Extract<NormalizedEvent, { type: 'assistant_text' }>
        rows[existing] = {
          envelope: {
            ...prev,
            event: { ...prevEv, text: prevEv.text + ev.text },
          },
        }
      } else {
        deltaRowIndex.set(ev.streamId, rows.length)
        rows.push({ envelope: e })
      }
      continue
    }
    if (ev.type === 'tool_use') {
      const pair: ToolPair = {
        use: ev,
        useEnvelope: e,
        result: resultByToolId.get(ev.id),
      }
      pairs.push(pair)
      rows.push({ envelope: e, pair })
    } else {
      rows.push({ envelope: e })
    }
  }
  return { rows, pairs }
}

export interface ToolActivity {
  callCount: number
  errorCount: number
  files: string[]
  inputTokens: number
  outputTokens: number
}

export function sumTokens(events: EventEnvelope[]): { input: number; output: number } {
  let input = 0
  let output = 0
  for (const e of events) {
    if (e.event.type === 'usage') {
      input += e.event.inputTokens || 0
      output += e.event.outputTokens || 0
    }
  }
  return { input, output }
}

// 从 tool_use input 里尽力抽取涉及的文件路径(file_path / path / cmd 中的路径)。
function extractFile(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  for (const k of ['file_path', 'path', 'filePath', 'notebook_path']) {
    if (typeof o[k] === 'string') return o[k] as string
  }
  return null
}

export function summarizeTools(pairs: ToolPair[], events: EventEnvelope[] = []): ToolActivity {
  const files = new Set<string>()
  let errorCount = 0
  for (const p of pairs) {
    if (p.result?.isError) errorCount++
    const f = extractFile(p.use.input)
    if (f) files.add(f)
  }
  const tk = sumTokens(events)
  return {
    callCount: pairs.length,
    errorCount,
    files: [...files],
    inputTokens: tk.input,
    outputTokens: tk.output,
  }
}

export type FilterKind = 'all' | 'tools' | 'errors' | 'thinking'

export interface TraceGroup {
  type: 'trace_group'
  turnId: string
  events: Array<{ envelope: EventEnvelope; pair?: ToolPair }>
  thinkingCount: number
  callCount: number
  errorCount: number
}

export function clusterRows(
  rows: Array<{ envelope: EventEnvelope; pair?: ToolPair }>
): Array<{ envelope: EventEnvelope; pair?: ToolPair; group?: TraceGroup }> {
  const result: Array<{ envelope: EventEnvelope; pair?: ToolPair; group?: TraceGroup }> = []
  let currentGroup: TraceGroup | null = null

  const flushGroup = () => {
    if (!currentGroup) return
    result.push({ envelope: currentGroup.events[0].envelope, group: currentGroup })
    currentGroup = null
  }

  for (const row of rows) {
    const ev = row.envelope.event
    const isTraceable = ev.type === 'thinking' || ev.type === 'tool_use'

    if (isTraceable) {
      const turnId = row.envelope.turnId || 'global'
      if (currentGroup && currentGroup.turnId === turnId) {
        currentGroup.events.push(row)
        if (ev.type === 'thinking') currentGroup.thinkingCount++
        if (ev.type === 'tool_use') {
          currentGroup.callCount++
          if (row.pair?.result?.isError) currentGroup.errorCount++
        }
      } else {
        flushGroup()
        currentGroup = {
          type: 'trace_group',
          turnId,
          events: [row],
          thinkingCount: ev.type === 'thinking' ? 1 : 0,
          callCount: ev.type === 'tool_use' ? 1 : 0,
          errorCount: ev.type === 'tool_use' && row.pair?.result?.isError ? 1 : 0,
        }
      }
    } else {
      flushGroup()
      result.push(row)
    }
  }

  flushGroup()

  return result
}

export function rowMatchesFilter(
  row: TimelineModel['rows'][number],
  kind: FilterKind,
  keyword: string,
): boolean {
  const ev = row.envelope.event
  if (kind === 'tools' && ev.type !== 'tool_use') return false
  if (kind === 'thinking' && ev.type !== 'thinking') return false
  if (kind === 'errors' && !(ev.type === 'tool_use' && row.pair?.result?.isError)) return false

  if (keyword.trim()) {
    const k = keyword.toLowerCase()
    const hay = JSON.stringify(ev).toLowerCase()
    const resultHay = row.pair?.result ? row.pair.result.output.toLowerCase() : ''
    if (!hay.includes(k) && !resultHay.includes(k)) return false
  }
  return true
}

// 把群组里的工具调用合并成简短分类标签:相邻同名合并为「Edit ×3」,最多展示 4 个,余下汇总成 「+N」。
export function summarizeToolNames(group: TraceGroup): string[] {
  const names: string[] = []
  for (const row of group.events) {
    const ev = row.envelope.event
    if (ev.type !== 'tool_use') continue
    names.push(ev.name)
  }
  if (names.length === 0) return []
  const merged: string[] = []
  let i = 0
  while (i < names.length) {
    let j = i + 1
    while (j < names.length && names[j] === names[i]) j++
    const count = j - i
    merged.push(count > 1 ? `${names[i]} ×${count}` : names[i])
    i = j
  }
  if (merged.length <= 4) return merged
  return [...merged.slice(0, 3), `+${merged.length - 3}`]
}
