import type { EventEnvelope, NormalizedEvent } from './types'
import { parseApplyPatch } from './apply-patch'

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
  // 审批的挂起/解决态由顶部 approval banner 单独渲染;落盘 meta 只用于审计,不占 timeline 槽位。
  'approval_required',
  'approval_resolved',
  'run_permissions',
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
  //
  // 兜底:同一个 turn/run/agent 内,如果两次 delta 的 streamId 不同(Claude CLI 有时会在
  // 一次流式回复里发多个 message_start,导致 msgId 变化;Codex app-server 也可能 itemId
  // 缺失),但它们「相邻」——中间没有 tool_use / thinking 等非 delta 事件——就并到同一
  // 个流式气泡里,避免出现「介」「绍俄罗斯…」这种拆成两个 bubble 的现象。
  const deltaRowIndex = new Map<string, number>()
  const rowTurnKey = (env: EventEnvelope): string =>
    `${env.turnId ?? ''}:${env.runId ?? ''}:${('agent' in env.event && env.event.agent) || ''}`
  for (const e of events) {
    const ev = e.event
    if (ev.type === 'tool_result') continue // 折进配对的 tool_use 卡
    if (isNoiseEvent(e)) continue // 不让噪音事件占用虚拟列表槽位
    if (ev.type === 'assistant_text' && ev.delta) {
      const sid = ev.streamId
      if (sid) {
        const turnKey = streamTurnKey.get(sid)
        const finalText = turnKey ? finalTextByTurnKey.get(turnKey) : undefined
        const deltaText = deltaTextByStreamId.get(sid) ?? ''
        if (
          finalizedStreamIds.has(sid) ||
          (deltaText.length > 0 && finalText?.includes(deltaText))
        ) {
          continue // 终态已到,丢弃 delta
        }
        const existing = deltaRowIndex.get(sid)
        if (existing != null) {
          const prev = rows[existing].envelope
          const prevEv = prev.event as Extract<NormalizedEvent, { type: 'assistant_text' }>
          rows[existing] = {
            envelope: { ...prev, event: { ...prevEv, text: prevEv.text + ev.text } },
          }
          continue
        }
      }
      // 尾行是同一个 turn/run/agent 的流式 assistant_text → 直接接上,不新起气泡。
      const last = rows[rows.length - 1]
      if (
        last &&
        last.envelope.event.type === 'assistant_text' &&
        rowTurnKey(last.envelope) === rowTurnKey(e)
      ) {
        const prevEv = last.envelope.event as Extract<NormalizedEvent, { type: 'assistant_text' }>
        rows[rows.length - 1] = {
          envelope: { ...last.envelope, event: { ...prevEv, text: prevEv.text + ev.text } },
        }
        if (sid) deltaRowIndex.set(sid, rows.length - 1)
        continue
      }
      if (sid) deltaRowIndex.set(sid, rows.length)
      rows.push({ envelope: e })
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

// 文件热力:按 tool_use 触碰的文件路径聚合。
// 用于「AI 到底看/改了我的哪些文件」的鸟瞰视角。
export interface FileTouch {
  toolName: string
  envelope: EventEnvelope
  isError: boolean
  agent?: string
  kind: 'read' | 'write' | 'other'
  adds?: number
  dels?: number
}
export interface FileHeatEntry {
  path: string
  count: number
  reads: number
  writes: number
  errors: number
  adds: number
  dels: number
  touches: FileTouch[]
  // 语义标签(比原始 count 更能指导 review):
  blindWrite: boolean // 有过写但之前从未读过该文件 → AI 盲改
  struggle: boolean   // 反复挣扎:写次数 ≥ 5 或有 error
  readOnly: boolean   // 只读没改
}

const READ_TOOL_NAMES = new Set([
  'Read', 'View', 'read_file', 'Grep', 'Glob', 'NotebookRead',
])
const WRITE_TOOL_NAMES = new Set([
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch', 'write_file',
])

function pushTouch(map: Map<string, FileHeatEntry>, path: string, touch: FileTouch) {
  let e = map.get(path)
  if (!e) {
    e = {
      path, count: 0, reads: 0, writes: 0, errors: 0, adds: 0, dels: 0, touches: [],
      blindWrite: false, struggle: false, readOnly: false,
    }
    map.set(path, e)
  }
  e.count++
  if (touch.kind === 'read') e.reads++
  if (touch.kind === 'write') e.writes++
  if (touch.isError) e.errors++
  if (touch.adds) e.adds += touch.adds
  if (touch.dels) e.dels += touch.dels
  e.touches.push(touch)
}

function computeSemanticFlags(e: FileHeatEntry): void {
  // 顺序判定 blindWrite:touches 是按事件顺序 push 的,遇到首次写之前如果没读过 → 盲改。
  let sawRead = false
  let sawBlindWrite = false
  for (const t of e.touches) {
    if (t.kind === 'read') sawRead = true
    else if (t.kind === 'write' && !sawRead) { sawBlindWrite = true; break }
  }
  e.blindWrite = sawBlindWrite
  e.struggle = e.writes >= 5 || e.errors > 0
  e.readOnly = e.writes === 0 && e.reads > 0
}

// 语义风险分:blindWrite > struggle > 其它。同分再按 count。
function riskRank(e: FileHeatEntry): number {
  let r = 0
  if (e.blindWrite) r += 100
  if (e.struggle) r += 50
  if (e.errors > 0) r += 20
  if (e.writes > 0) r += 10
  return r
}

export function computeFileHeatmap(pairs: ToolPair[]): FileHeatEntry[] {
  const map = new Map<string, FileHeatEntry>()
  for (const p of pairs) {
    const toolName = p.use.name
    const isError = Boolean(p.result?.isError)
    const agent = (p.use as { agent?: string }).agent
    const envelope = p.useEnvelope
    const kind: FileTouch['kind'] = READ_TOOL_NAMES.has(toolName)
      ? 'read'
      : WRITE_TOOL_NAMES.has(toolName)
      ? 'write'
      : 'other'

    if (toolName === 'apply_patch') {
      const files = parseApplyPatch(p.use.input)
      if (files && files.length > 0) {
        for (const f of files) {
          pushTouch(map, f.path, {
            toolName,
            envelope,
            isError,
            agent,
            kind: 'write',
            adds: f.adds,
            dels: f.dels,
          })
        }
        continue
      }
    }
    const path = extractFile(p.use.input)
    if (!path) continue
    pushTouch(map, path, { toolName, envelope, isError, agent, kind })
  }
  const entries = [...map.values()]
  for (const e of entries) computeSemanticFlags(e)
  return entries.sort((a, b) => {
    const dr = riskRank(b) - riskRank(a)
    if (dr !== 0) return dr
    return b.count - a.count || a.path.localeCompare(b.path)
  })
}

export type FilterKind = 'all' | 'tools' | 'errors' | 'thinking'

// ── 视图 A · 叙事线 ─────────────────────────────────────
// 把 timeline 从"每条事件一行"折成"每 turn 一行":一句话说 AI 做了什么。
// 详细展示由展开/TraceDrawer 承担。
export interface TurnMetrics {
  reads: number       // 次数
  writes: number      // 次数
  readFiles: number   // 去重文件数
  writeFiles: number  // 去重文件数
  bashCount: number
  thinkingCount: number
  adds: number
  dels: number
  errors: number
  hasTest: boolean
  hasPatch: boolean
  events: number
  files: string[]     // 去重
}

/** 一个 assistant turn 干了什么。判别用 kind,显示交给 i18n。 */
export type NarrativeAction =
  | { kind: 'test'; failed: boolean }
  | { kind: 'read-write'; read: number; write: number; diff: string }
  | { kind: 'write'; write: number; diff: string }
  | { kind: 'analyze'; read: number }
  | { kind: 'review'; read: number }
  | { kind: 'bash'; count: number }
  | { kind: 'think'; steps: number }
  | { kind: 'reply'; preview: string }

export type NarrativeRow =
  | { kind: 'user'; key: string; envelope: EventEnvelope; text: string; ts?: string }
  | { kind: 'boundary'; key: string; envelope: EventEnvelope }
  | {
      kind: 'assistant'
      key: string
      turnId?: string
      agent?: string
      events: Array<{ envelope: EventEnvelope; pair?: ToolPair }>
      metrics: TurnMetrics
      /** 结构化动作描述;显示文案由组件用 i18n 渲染,timeline 层不产出人类语言。 */
      action: NarrativeAction
      preview?: string     // 第一句 assistant_text,浅色副行
      firstEnvelope: EventEnvelope
      durationMs?: number
    }

function isTestCmd(cmd: string): boolean {
  return /\b(pytest|jest|vitest|npm\s+test|pnpm\s+test|yarn\s+test|tsc|typecheck|go\s+test|cargo\s+test|mocha)\b/i.test(cmd)
}
function isBuildCmd(cmd: string): boolean {
  return /\b(build|compile|webpack|rollup|vite\s+build|next\s+build)\b/i.test(cmd)
}
function extractBashCmd(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>
    for (const k of ['command', 'cmd']) if (typeof o[k] === 'string') return o[k] as string
  }
  return ''
}
function firstSentence(text: string): string {
  const s = text.trim().replace(/^#+\s*/, '')
  const m = s.match(/^([^.。!?\n]{4,120})[.。!?\n]/)
  return (m ? m[1] : s.slice(0, 120)).trim()
}

// 主动词规则:优先级从高到低。只产出结构化描述,不产出人类语言 —— 文案由 NarrativeTimeline
// 经 i18n 渲染,组件也据 kind(而非显示字符串)判断是不是「回复」行。
function actionFor(m: TurnMetrics, preview: string | undefined): NarrativeAction {
  const diff = m.adds || m.dels ? ` +${m.adds} −${m.dels}` : ''
  if (m.hasTest) return { kind: 'test', failed: m.errors > 0 }
  if (m.writeFiles > 0 && m.readFiles > 0) {
    return { kind: 'read-write', read: m.readFiles, write: m.writeFiles, diff }
  }
  if (m.writeFiles > 0) return { kind: 'write', write: m.writeFiles, diff }
  if (m.readFiles >= 4) return { kind: 'analyze', read: m.readFiles }
  if (m.readFiles > 0) return { kind: 'review', read: m.readFiles }
  if (m.bashCount > 0) return { kind: 'bash', count: m.bashCount }
  if (m.thinkingCount > 0 && !preview) return { kind: 'think', steps: m.thinkingCount }
  return { kind: 'reply', preview: preview ?? '' }
}

// 从一批 assistant turn 内的 events 抽取 metrics。
function collectMetrics(rows: Array<{ envelope: EventEnvelope; pair?: ToolPair }>): {
  metrics: TurnMetrics
  preview?: string
} {
  const m: TurnMetrics = {
    reads: 0, writes: 0, readFiles: 0, writeFiles: 0,
    bashCount: 0, thinkingCount: 0, adds: 0, dels: 0, errors: 0,
    hasTest: false, hasPatch: false, events: rows.length, files: [],
  }
  const readSet = new Set<string>()
  const writeSet = new Set<string>()
  let preview: string | undefined
  for (const r of rows) {
    const ev = r.envelope.event
    if (ev.type === 'thinking') { m.thinkingCount++; continue }
    if (ev.type === 'assistant_text' && !preview && ev.text.trim()) preview = firstSentence(ev.text)
    if (ev.type !== 'tool_use') continue
    const name = ev.name
    if (r.pair?.result?.isError) m.errors++
    if (name === 'Bash' || name === 'shell') {
      m.bashCount++
      const cmd = extractBashCmd(ev.input)
      if (isTestCmd(cmd)) m.hasTest = true
      if (isBuildCmd(cmd)) m.hasTest = m.hasTest // no-op, could add hasBuild
      continue
    }
    if (name === 'apply_patch') {
      m.hasPatch = true
      const files = parseApplyPatch(ev.input) ?? []
      for (const f of files) {
        writeSet.add(f.path)
        m.writes++
        m.adds += f.adds
        m.dels += f.dels
      }
      continue
    }
    const path = extractFile(ev.input)
    if (READ_TOOL_NAMES.has(name)) { m.reads++; if (path) readSet.add(path); continue }
    if (WRITE_TOOL_NAMES.has(name)) { m.writes++; if (path) writeSet.add(path); continue }
  }
  m.readFiles = readSet.size
  m.writeFiles = writeSet.size
  m.files = [...new Set([...readSet, ...writeSet])]
  return { metrics: m, preview }
}

// 按 turn 折叠 rows(未 clusterRows/未 fold 之前的 buildTimeline.rows):
//   - user_text → user 行
//   - followup_boundary → boundary
//   - 其它按 (turnId + agent) 聚成一个 assistant 行
// 顺序严格保留 append 顺序(不变量 3)。
export function buildTurns(
  rows: Array<{ envelope: EventEnvelope; pair?: ToolPair }>,
): NarrativeRow[] {
  const out: NarrativeRow[] = []
  let bucket: Array<{ envelope: EventEnvelope; pair?: ToolPair }> = []
  let bucketKey: string | null = null
  let bucketFirst: EventEnvelope | null = null
  let bucketTs: string | undefined

  const flush = () => {
    if (!bucket.length || !bucketFirst) return
    const { metrics, preview } = collectMetrics(bucket)
    const action = actionFor(metrics, preview)
    const ev0 = bucketFirst.event
    const agent = ('agent' in ev0 && ev0.agent) ? ev0.agent : undefined
    const lastTs = bucket[bucket.length - 1].envelope.event.ts
    const durationMs = bucketTs && lastTs ? Math.max(0, new Date(lastTs).getTime() - new Date(bucketTs).getTime()) : undefined
    out.push({
      kind: 'assistant',
      key: `a:${bucketKey}:${bucketFirst.sourceEventId ?? out.length}`,
      turnId: bucketFirst.turnId,
      agent,
      events: bucket,
      metrics,
      action,
      preview,
      firstEnvelope: bucketFirst,
      durationMs,
    })
    bucket = []
    bucketKey = null
    bucketFirst = null
    bucketTs = undefined
  }

  for (const row of rows) {
    const env = row.envelope
    const ev = env.event
    if (ev.type === 'user_text') {
      flush()
      out.push({
        kind: 'user',
        key: `u:${env.sourceEventId ?? out.length}`,
        envelope: env,
        text: ev.text,
        ts: ev.ts,
      })
      continue
    }
    if (ev.type === 'followup_boundary') {
      flush()
      out.push({ kind: 'boundary', key: `b:${env.sourceEventId ?? out.length}`, envelope: env })
      continue
    }
    const agent = ('agent' in ev && ev.agent) ? ev.agent : ''
    const key = `${env.turnId ?? ''}:${agent}`
    if (bucketKey === null) {
      bucketKey = key
      bucketFirst = env
      bucketTs = ev.ts
    } else if (bucketKey !== key) {
      flush()
      bucketKey = key
      bucketFirst = env
      bucketTs = ev.ts
    }
    bucket.push(row)
  }
  flush()
  return out
}

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

// 把「trace group → 紧邻其后的 assistant_text」折叠成一行:
// group 不再独占一行,而是作为 assistant bubble 上的 precedingGroup 展示。
// 只在无 filter/keyword 的默认视图里用,避免筛选态时丢事件。
export function foldGroupsIntoAssistant(
  rows: Array<{ envelope: EventEnvelope; pair?: ToolPair; group?: TraceGroup }>,
): Array<{ envelope: EventEnvelope; pair?: ToolPair; group?: TraceGroup; precedingGroup?: TraceGroup }> {
  const out: Array<{
    envelope: EventEnvelope
    pair?: ToolPair
    group?: TraceGroup
    precedingGroup?: TraceGroup
  }> = []
  let pending: TraceGroup | null = null
  for (const row of rows) {
    if (row.group) {
      pending = row.group
      continue
    }
    const ev = row.envelope.event
    if (ev.type === 'assistant_text' && pending) {
      out.push({ ...row, precedingGroup: pending })
      pending = null
      continue
    }
    if (pending) {
      // group 后跟着的不是 assistant(比如 user_text / usage / boundary),
      // 说明这一轮还没出正文,保留 pill 独立展示。
      out.push({ envelope: pending.events[0].envelope, group: pending })
      pending = null
    }
    out.push(row)
  }
  if (pending) out.push({ envelope: pending.events[0].envelope, group: pending })
  return out
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

// MCP 工具原生名太啰嗦:`mcp__Claude_Preview__preview_resize` → `preview_resize`。
// 非 MCP 工具保持原名。极端长的名也截断兜底。
export function prettyToolName(name: string): string {
  if (!name) return name
  if (name.startsWith('mcp__')) {
    const parts = name.split('__').filter(Boolean)
    if (parts.length >= 3) return parts.slice(2).join('__')
  }
  return name.length > 32 ? name.slice(0, 30) + '…' : name
}

// 把群组里的工具调用合并成简短分类标签:相邻同名合并为「Edit ×3」,最多展示 4 个,余下汇总成 「+N」。
// 名字统一走 prettyToolName,避免 mcp__ 前缀撑破 UI。
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
    const pretty = prettyToolName(names[i])
    merged.push(count > 1 ? `${pretty} ×${count}` : pretty)
    i = j
  }
  if (merged.length <= 4) return merged
  return [...merged.slice(0, 3), `+${merged.length - 3}`]
}
