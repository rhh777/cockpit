import type { ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { AgentName, ChatAttachment, EventEnvelope, NormalizedEvent, Source } from '../loaders/types'
import { agentForNativeSource, resolveAgent } from '../adapters/registry'
import { filterToolResult, redactSecrets } from '../adapters/sensitive'
import { buildGroupContextEvents } from '../adapters/serialize'
import { renderAttachmentLines } from '../util/attachments'
import { parseSerialDirective, selectNextAgentFromDirective, type SerialDirective } from '../util/serial-directive'
import { projectContextEvents } from '../adapters/context-projector'
import { threadContextStore } from '../store/thread-context-store'
import { scheduleSummaryRefresh } from '../adapters/summary-refresh'
import { loadSessionDetail } from '../sessions-service'
import { threadStore } from '../store/thread-store'
import { groupThreadStore } from '../store/group-thread-store'
import type { RunRecord, RunStatus } from './run-store'
import { runStore } from './run-store'
import { nativeShadowStore } from './native-shadow-store'
import { translateNotification } from '../adapters/codex-app-server'
import { codexRuntimeManager, type CodexRuntimeLease } from '../adapters/codex-runtime-manager'
import type { NativeWriteMode } from '../adapters/types'
import { approvalStore } from '../approvals/approval-store'
import type { ApprovalDecision, ApprovalRequest, Operation, RunPermissions } from '../permissions/types'

const CODEX_CONTINUATION_INTERRUPT_TIMEOUT_MS = 5_000

// Phase 4 incremental 门槛:原生事件 > 50 或估算文本 > 12000 chars 才切换到 summary 前缀模式。
// 短 session 全量已够,增量反而丢细节。
const INCREMENTAL_EVENT_THRESHOLD = 50
const INCREMENTAL_TEXT_THRESHOLD = 12000

export function serialCompletionNotification(
  reason: string,
  steps: number,
  detailStatus?: SerialDirective['status'],
): string {
  if (reason === 'consensus') return `@user 接力讨论已在 ${steps} 次发言后达成一致。`
  if (reason === 'max-steps') return `@user 接力讨论已达到 ${steps} 次发言上限;请检查仍未收敛的分歧。`
  if (reason === 'no-next-agent' && detailStatus === 'blocked') return '@user 接力讨论需要你的决定后才能继续。'
  if (reason === 'no-next-agent') return '@user agent 已把讨论交回给你。'
  if (reason === 'aborted') return '@user 接力讨论已取消。'
  if (reason === 'protocol-missing') return '@user 接力协议修复失败,讨论已停止。'
  return '@user 接力讨论因 agent 失败而停止。'
}

function shouldUseIncrementalForRegistry(events: EventEnvelope[]): boolean {
  if (events.length > INCREMENTAL_EVENT_THRESHOLD) return true
  let chars = 0
  for (const env of events) {
    const e = env.event
    if (e.type === 'user_text' || e.type === 'assistant_text' || e.type === 'thinking') chars += e.text.length
    else if (e.type === 'tool_result') chars += e.output.length
    if (chars > INCREMENTAL_TEXT_THRESHOLD) return true
  }
  return false
}

export type RunPhase =
  | 'queued'
  | 'warming_runtime'
  | 'runtime_ready'
  | 'building_context'
  | 'starting_turn'
  | 'streaming'
  | 'waiting_approval'
  | 'completed'
  | 'failed'

export type RunStreamMessage =
  | { kind: 'meta'; turnId: string; runId: string; native?: boolean }
  | { kind: 'run_phase'; turnId: string; runId: string; phase: RunPhase }
  | { kind: 'event'; envelope: EventEnvelope }
  | { kind: 'done'; turnId: string; status: string }
  | { kind: 'aborted'; turnId: string; status: string; message?: string }
  | { kind: 'error'; turnId?: string; status?: string; message?: string }
  | { kind: 'approval_required'; approval: ApprovalRequest }
  | { kind: 'approval_resolved'; approvalId: string; status: 'approved' | 'rejected' }
  | {
      kind: 'meta'
      groupTurnId: string
      baseEventSeq: number
      runs: { agent: AgentName; runId: string }[]
    }
  | { kind: 'run_phase'; groupTurnId: string; runId: string; agent: AgentName; phase: RunPhase }
  | { kind: 'event'; groupTurnId: string; runId?: string; agent?: AgentName; envelope: EventEnvelope }
  | {
      kind: 'run_done'
      groupTurnId: string
      runId: string
      agent: AgentName
      status: 'completed' | 'failed' | 'aborted'
      message?: string
    }
  | { kind: 'done'; groupTurnId: string; status: 'completed' | 'partial' | 'failed' | 'aborted'; message?: string }
  | { kind: 'serial_step'; groupTurnId: string; step: number; maxSteps: number; agent: AgentName; runId: string }

interface FollowupStartInput {
  source: Source
  sessionId: string
  filePath: string
  text: string
  targetAgent: AgentName
  useTools: boolean
  permissions: RunPermissions
  parentTurnId?: string
  model?: string
  effort?: string
  attachments?: ChatAttachment[]
  // Phase 2 opt-in:仅 Codex 消费,非 Codex 忽略。
  codexAcceleratedMode?: boolean
}

interface GroupTurnStartInput {
  id: string
  text: string
  targetAgents: AgentName[]
  mode?: 'parallel' | 'serial'
  serial?: {
    participants: AgentName[]
    firstAgent: AgentName
    maxSteps: number
    stopOnConsensus: boolean
    preset?: 'architecture-first' | 'implementation-first' | 'peer-review'
  }
  serialContext?: {
    step: number
    previousAgent?: AgentName
  }
  useTools: boolean
  permissions: RunPermissions
  cliByAgent?: Partial<Record<AgentName, { model?: string; effort?: string }>>
  attachments?: ChatAttachment[]
  // Phase 2 opt-in:仅 Codex 消费。开启后 Codex member 复用 provider thread,产生原生 session 副作用。
  codexAcceleratedMode?: boolean
}

interface NativeStartInput {
  source: Source
  sessionId: string
  filePath: string
  text: string
  attachments?: ChatAttachment[]
  /** Native resume 只有两档;缺省 read-only。 */
  writeMode?: NativeWriteMode
  /** 推理强度;缺省使用 Cockpit 设置中该 agent 的默认值。 */
  effort?: string
}

interface NativeContinuationInput {
  handoffId: string
  cwd: string | null
  prompt: string
}

interface Subscriber {
  id: string
  res: ServerResponse
}

class RunHandle {
  readonly controller = new AbortController()
  readonly subscribers = new Map<string, Subscriber>()
  readonly replay: RunStreamMessage[] = []
  // 「总是允许」记忆(docs/12 C2):用户选 approved_always 后,本 run 内同类操作不再弹卡。
  readonly alwaysGrantedKinds = new Set<Operation['kind']>()
  private terminal: RunStatus | null = null

  constructor(public record: RunRecord, private readonly onWrite?: (msg: RunStreamMessage) => void) {}

  write(msg: RunStreamMessage) {
    // 打字机 delta 逐条进 replay 会让长回复的 replay 涨到数万条(docs/12 G1)。
    // 同 streamId 的相邻 delta 合并成一条累积 delta:实时订阅者仍收到原始碎片,
    // 重连 attach 时收到的是合并结果(UI 端 buildTimeline 本来就按 streamId 拼接,语义等价)。
    if (!this.mergeDeltaIntoReplay(msg)) this.replay.push(msg)
    for (const sub of this.subscribers.values()) sseWrite(sub.res, msg)
    this.onWrite?.(msg)
  }

  private mergeDeltaIntoReplay(msg: RunStreamMessage): boolean {
    if (msg.kind !== 'event') return false
    const ev = msg.envelope.event
    if (ev.type !== 'assistant_text' || ev.delta !== true || !ev.streamId) return false
    const last = this.replay[this.replay.length - 1]
    if (!last || last.kind !== 'event') return false
    const lev = last.envelope.event
    if (lev.type !== 'assistant_text' || lev.delta !== true || lev.streamId !== ev.streamId) return false
    // 克隆合并,不改动已发给实时订阅者的对象;保留首个 delta 的 sourceEventId,重放顺序不变。
    this.replay[this.replay.length - 1] = {
      ...last,
      envelope: { ...last.envelope, event: { ...lev, text: lev.text + ev.text } },
    } as RunStreamMessage
    return true
  }

  attach(res: ServerResponse) {
    const id = randomUUID()
    this.subscribers.set(id, { id, res })
    for (const msg of this.replay) sseWrite(res, msg)
    return () => {
      this.subscribers.delete(id)
    }
  }

  async finish(status: Exclude<RunStatus, 'running' | 'interrupted'>, error?: string) {
    if (this.terminal) return false
    this.terminal = status
    const endedAt = new Date().toISOString()
    this.record = {
      ...this.record,
      status,
      endedAt,
      ...(error ? { error } : {}),
    }
    await runStore.append(this.record)
    return true
  }
}

interface ActiveGroupTurn {
  groupTurnId: string
  baseEventSeq: number
  runIds: string[]
  mode?: 'parallel' | 'serial'
  aborted?: boolean
  subscribers: Map<string, Subscriber>
  replay: RunStreamMessage[]
}

function sseWrite(res: ServerResponse, msg: unknown) {
  if (res.writableEnded) return
  res.write(`data: ${JSON.stringify(msg)}\n\n`)
  ;(res as ServerResponse & { flush?: () => void }).flush?.()
}

function wrap(source: Source, ev: NormalizedEvent, turnId: string, runId: string): EventEnvelope {
  return {
    origin: 'cockpit',
    source,
    sourceEventId: ev.type === 'tool_use' ? ev.id : `evt_${randomUUID()}`,
    turnId,
    runId,
    event: ev,
  }
}

function wrapNative(source: Source, ev: NormalizedEvent, turnId: string, runId: string): EventEnvelope {
  return {
    origin: 'native',
    source,
    sourceEventId: ev.type === 'tool_use' ? ev.id : `native:${runId}:${randomUUID()}`,
    turnId,
    runId,
    event: ev,
  }
}

function wrapGroup(ev: NormalizedEvent, turnId: string, runId?: string): EventEnvelope {
  return {
    origin: 'cockpit',
    source: 'cockpit',
    sourceEventId: ev.type === 'tool_use' ? ev.id : `evt_${randomUUID()}`,
    turnId,
    runId,
    event: ev,
  }
}

function runPermissionsMeta(source: Source, turnId: string, runId: string, permissions: RunPermissions): EventEnvelope {
  return {
    origin: 'cockpit',
    source,
    sourceEventId: `permissions:${runId}`,
    turnId,
    runId,
    event: {
      type: 'meta',
      key: 'run_permissions',
      value: permissions,
      ts: new Date().toISOString(),
    },
  }
}

function emitPhase(handle: RunHandle, phase: RunPhase) {
  const { turnId, runId, agent, groupThreadId } = handle.record
  if (groupThreadId) {
    handle.write({ kind: 'run_phase', groupTurnId: turnId, runId, agent, phase })
  } else {
    handle.write({ kind: 'run_phase', turnId, runId, phase })
  }
}

function notificationTurnId(params: unknown): string | null {
  if (!params || typeof params !== 'object') return null
  const record = params as Record<string, unknown>
  const camel = record.turnId
  if (typeof camel === 'string' && camel.length > 0) return camel
  const snake = record.turn_id
  if (typeof snake === 'string' && snake.length > 0) return snake
  const turn = record.turn
  if (turn && typeof turn === 'object') {
    const nested = (turn as Record<string, unknown>).id
    if (typeof nested === 'string' && nested.length > 0) return nested
  }
  return null
}

// 单会话 follow-up / native 续写没有 group 的 context preview,附件引用行直接拼到当前请求文本里,
// CLI 凭路径读取(图片已落 attachments 目录,file/directory 是原路径)。
function withAttachments(text: string, attachments?: ChatAttachment[]): string {
  const lines = renderAttachmentLines(attachments)
  if (lines.length === 0) return text
  return [text, '', ...lines].join('\n')
}

function overallGroupStatus(statuses: RunStatus[]): 'completed' | 'partial' | 'failed' {
  const completed = statuses.filter((s) => s === 'completed').length
  if (completed === statuses.length) return 'completed'
  if (completed > 0) return 'partial'
  return 'failed'
}

class RunRegistry {
  private runs = new Map<string, RunHandle>()
  private groupTurns = new Map<string, ActiveGroupTurn>()
  private completedGroupTurns = new Map<string, ActiveGroupTurn>()
  private approvalWaiters = new Map<string, (status: ApprovalDecision) => void>()
  private initialized = false

  async init() {
    if (this.initialized) return
    this.initialized = true
    await runStore.markInterruptedOnStartup()
  }

  get(runId: string): RunHandle | undefined {
    return this.runs.get(runId)
  }

  getGroupTurn(groupThreadId: string, groupTurnId: string): ActiveGroupTurn | undefined {
    const active = this.groupTurns.get(groupThreadId)
    if (active?.groupTurnId === groupTurnId) return active
    return this.completedGroupTurns.get(`${groupThreadId}:${groupTurnId}`)
  }

  attachGroupTurn(groupThreadId: string, groupTurnId: string, res: ServerResponse) {
    const active = this.getGroupTurn(groupThreadId, groupTurnId)
    if (!active) return undefined
    const id = randomUUID()
    active.subscribers.set(id, { id, res })
    for (const msg of active.replay) sseWrite(res, msg)
    return () => {
      active.subscribers.delete(id)
    }
  }

  private makeActiveGroupTurn(
    groupTurnId: string,
    baseEventSeq: number,
    runIds: string[] = [],
    mode: 'parallel' | 'serial' = 'parallel',
  ): ActiveGroupTurn {
    return { groupTurnId, baseEventSeq, runIds, mode, subscribers: new Map(), replay: [] }
  }

  private writeGroupTurn(groupThreadId: string | undefined, groupTurnId: string | undefined, msg: RunStreamMessage) {
    if (!groupThreadId || !groupTurnId) return
    const active = this.getGroupTurn(groupThreadId, groupTurnId)
    if (!active) return
    active.replay.push(msg)
    for (const sub of active.subscribers.values()) sseWrite(sub.res, msg)
  }

  private archiveGroupTurnReplay(groupThreadId: string, groupTurnId: string) {
    const active = this.getGroupTurn(groupThreadId, groupTurnId)
    if (!active) return
    const key = `${groupThreadId}:${groupTurnId}`
    this.completedGroupTurns.set(key, active)
    setTimeout(() => {
      if (this.completedGroupTurns.get(key) === active) this.completedGroupTurns.delete(key)
    }, 5 * 60 * 1000).unref?.()
  }

  private makeGroupHandle(record: RunRecord): RunHandle {
    return new RunHandle(record, (msg) => {
      if ('groupTurnId' in msg) this.writeGroupTurn(record.groupThreadId, record.turnId, msg)
    })
  }

  private createGroupRunRecord(input: GroupTurnStartInput, groupTurnId: string, agent: AgentName, startedAt: string): RunRecord {
    return {
      runId: `run_${randomUUID()}`,
      kind: 'group-member',
      status: 'running',
      groupThreadId: input.id,
      turnId: groupTurnId,
      agent,
      permissions: input.permissions,
      startedAt,
    }
  }

  listRunningForSession(source: Source, sessionId: string): RunRecord[] {
    return [...this.runs.values()]
      .map((h) => h.record)
      .filter((r) => r.status === 'running' && r.source === source && r.sessionId === sessionId)
  }

  listRunning(): RunRecord[] {
    return [...this.runs.values()].map((h) => h.record).filter((r) => r.status === 'running')
  }

  async startFollowup(input: FollowupStartInput): Promise<{ record: RunRecord; userEnvelope: EventEnvelope }> {
    await this.init()
    const turnId = `turn_${randomUUID()}`
    const runId = `run_${randomUUID()}`
    const startedAt = new Date().toISOString()
    const record: RunRecord = {
      runId,
      kind: 'followup',
      status: 'running',
      source: input.source,
      sessionId: input.sessionId,
      turnId,
      parentTurnId: input.parentTurnId,
      agent: input.targetAgent,
      permissions: input.permissions,
      startedAt,
    }
    await runStore.append(record)

    const userEnvelope: EventEnvelope = {
      origin: 'cockpit',
      source: input.source,
      sourceEventId: `evt_${randomUUID()}`,
      turnId,
      runId,
      event: {
        type: 'user_text',
        text: input.text,
        ts: startedAt,
        targetAgent: input.targetAgent,
        parentTurnId: input.parentTurnId,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      },
    }
    await threadStore.appendEvent(input.source, input.sessionId, userEnvelope)
    const permissionsEnvelope = runPermissionsMeta(input.source, turnId, runId, input.permissions)
    await threadStore.appendEvent(input.source, input.sessionId, permissionsEnvelope)

    const handle = new RunHandle(record)
    handle.write({ kind: 'meta', turnId, runId })
    emitPhase(handle, 'queued')
    handle.write({ kind: 'event', envelope: userEnvelope })
    handle.write({ kind: 'event', envelope: permissionsEnvelope })
    this.runs.set(runId, handle)
    void this.executeFollowup(handle, input)
    return { record, userEnvelope }
  }

  async startGroupTurn(input: GroupTurnStartInput): Promise<{
    groupTurnId: string
    baseEventSeq: number
    records: RunRecord[]
    userEnvelope: EventEnvelope
    turnStart?: EventEnvelope
    mode?: 'parallel' | 'serial'
  }> {
    await this.init()
    const serialMode = input.mode === 'serial'
    if (serialMode) return this.startSerialGroupTurn(input)
    const wake = input.targetAgents.length > 0
    // 互斥必须在任何 await 之前同步占位,否则并发两次唤醒都能通过 has() 检查(docs/12 G2)。
    // 失败路径在 catch 里回滚占位;成功后被真实 ActiveGroupTurn 覆盖。
    if (wake) {
      if (this.groupTurns.has(input.id)) throw new Error('group turn already running')
      this.groupTurns.set(input.id, this.makeActiveGroupTurn('pending', -1))
    }
    try {
      const state = await groupThreadStore.readState(input.id)
      if (!state) throw new Error('group thread not found')

      const groupTurnId = `turn_${randomUUID()}`
      const now = new Date().toISOString()
      const userEnvelope = wrapGroup(
        {
          type: 'user_text',
          text: input.text,
          ts: now,
          targetAgents: input.targetAgents,
          mentions: input.targetAgents,
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        },
        groupTurnId,
      )
      const baseEventSeq = await groupThreadStore.appendEvent(input.id, userEnvelope)
      if (!wake) {
        return { groupTurnId, baseEventSeq, records: [], userEnvelope }
      }

      const records: RunRecord[] = input.targetAgents.map((agent) => ({
        runId: `run_${randomUUID()}`,
        kind: 'group-member',
        status: 'running',
        groupThreadId: input.id,
        turnId: groupTurnId,
        agent,
        permissions: input.permissions,
        startedAt: now,
      }))
      for (const record of records) await runStore.append(record)

      const runsMeta = records.map((r) => ({ runId: r.runId, agent: r.agent, turnId: groupTurnId, baseEventSeq, status: 'running' }))
      const turnStart = wrapGroup(
        {
          type: 'meta',
          key: 'turn_start',
          value: { groupTurnId, baseEventSeq, targetAgents: input.targetAgents, runs: runsMeta, permissions: input.permissions },
          ts: now,
        },
        groupTurnId,
      )
      await groupThreadStore.appendEvent(input.id, turnStart)

      const handles = records.map((record) => {
        const handle = this.makeGroupHandle(record)
        handle.write({ kind: 'meta', groupTurnId, baseEventSeq, runs: records.map(({ agent, runId }) => ({ agent, runId })) })
        emitPhase(handle, 'queued')
        handle.write({ kind: 'event', groupTurnId, envelope: userEnvelope })
        handle.write({ kind: 'event', groupTurnId, envelope: turnStart })
        this.runs.set(record.runId, handle)
        return handle
      })
      this.groupTurns.set(input.id, this.makeActiveGroupTurn(groupTurnId, baseEventSeq, records.map((r) => r.runId)))

      const transcript = (await groupThreadStore.readTranscript(input.id)).slice(0, baseEventSeq)
      const summary = await groupThreadStore.readSummary(input.id)
      void Promise.all(handles.map((h) => this.executeGroupMember(h, input, state.cwd, transcript, summary, baseEventSeq)))
        .finally(() => {
          const statuses = handles.map((h) => h.record.status)
          const status = overallGroupStatus(statuses)
          for (const handle of handles) handle.write({ kind: 'done', groupTurnId, status })
          this.groupTurns.delete(input.id)
        })

      return { groupTurnId, baseEventSeq, records, userEnvelope, turnStart }
    } catch (err) {
      // 只回滚仍是占位/本次写入的登记;runs 已经起来的情况不会走到这里。
      if (wake) this.groupTurns.delete(input.id)
      throw err
    }
  }

  private async startSerialGroupTurn(input: GroupTurnStartInput): Promise<{
    groupTurnId: string
    baseEventSeq: number
    records: RunRecord[]
    userEnvelope: EventEnvelope
    turnStart: EventEnvelope
    mode: 'serial'
  }> {
    if (!input.serial) throw new Error('serial options required')
    if (this.groupTurns.has(input.id)) throw new Error('group turn already running')
    this.groupTurns.set(input.id, this.makeActiveGroupTurn('pending', -1, [], 'serial'))
    try {
      const state = await groupThreadStore.readState(input.id)
      if (!state) throw new Error('group thread not found')

      const groupTurnId = `turn_${randomUUID()}`
      const now = new Date().toISOString()
      const participants = input.serial.participants
      const firstAgent = input.serial.firstAgent
      const userEnvelope = wrapGroup(
        {
          type: 'user_text',
          text: input.text,
          ts: now,
          targetAgents: [firstAgent],
          mentions: [firstAgent],
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        },
        groupTurnId,
      )
      const baseEventSeq = await groupThreadStore.appendEvent(input.id, userEnvelope)
      const firstRecord = this.createGroupRunRecord(input, groupTurnId, firstAgent, now)
      await runStore.append(firstRecord)
      const turnStart = wrapGroup(
        {
          type: 'meta',
          key: 'turn_start',
          value: {
            groupTurnId,
            mode: 'serial',
            baseEventSeq,
            targetAgents: [firstAgent],
            participants,
            serial: input.serial,
            runs: [{ runId: firstRecord.runId, agent: firstAgent, turnId: groupTurnId, baseEventSeq, status: 'running' }],
            permissions: input.permissions,
          },
          ts: now,
        },
        groupTurnId,
      )
      await groupThreadStore.appendEvent(input.id, turnStart)
      this.groupTurns.set(input.id, this.makeActiveGroupTurn(groupTurnId, baseEventSeq, [firstRecord.runId], 'serial'))

      const handle = this.makeGroupHandle(firstRecord)
      handle.write({ kind: 'meta', groupTurnId, baseEventSeq, runs: [{ agent: firstAgent, runId: firstRecord.runId }] })
      emitPhase(handle, 'queued')
      handle.write({ kind: 'event', groupTurnId, envelope: userEnvelope })
      handle.write({ kind: 'event', groupTurnId, envelope: turnStart })
      this.runs.set(firstRecord.runId, handle)

      void this.executeSerialGroupTurn(input, state.cwd, baseEventSeq, handle).catch((err) => {
        const message = String((err as Error)?.message ?? err)
        void this.finishSerialTurn(input.id, groupTurnId, 'failed', 'agent-failed', 0, message)
      })

      return { groupTurnId, baseEventSeq, records: [firstRecord], userEnvelope, turnStart, mode: 'serial' }
    } catch (err) {
      this.groupTurns.delete(input.id)
      throw err
    }
  }

  private serialRequest(original: string, step: number, maxSteps: number): string {
    return [
      original,
      '',
      `Serial discussion step ${step}/${maxSteps}.`,
      'Respond to the user task and previous discussion. End with exactly:',
      'Next: @agent-or-@user',
      'Status: needs-review | needs-changes | consensus | blocked',
    ].join('\n')
  }

  private latestAssistantText(transcript: EventEnvelope[], runId: string): string {
    const parts = transcript
      .filter((env) => env.runId === runId && env.event.type === 'assistant_text')
      .map((env) => (env.event.type === 'assistant_text' ? env.event.text : ''))
    return parts.join('\n').trim()
  }

  /**
   * docs/13 §调度算法 / §解析优先级 6:agent 忘写末尾协议块时,先向**同一 agent** 补问一次,
   * 只要那两行协议、不要重答;仍缺失才以 `protocol-missing` 结束。
   *
   * 少了这一步,agent 一次格式失误就会终止整场接力讨论 —— 这是接力模式最常见的失败模式。
   *
   * 约束:
   * - 每个 step 只补问一次(由调用点保证,helper 自身不重试)。
   * - **不占用发言预算**:`step` 与 `completedSteps` 都不推进。补协议不是一次发言。
   * - 强制 `useTools: false`:只要两行协议,不该再去跑工具。
   * - 独立 runId + `serial_protocol_repair` meta,timeline 能看出这是补协议而非正常发言。
   */
  private async requestProtocolRepairOnce(
    input: GroupTurnStartInput,
    cwd: string | null,
    summary: string,
    groupTurnId: string,
    baseEventSeq: number,
    agentName: AgentName,
    previousAgent: AgentName | undefined,
    step: number,
    failure: SerialDirective,
  ): Promise<
    | { kind: 'repaired'; directive: SerialDirective }
    | { kind: 'still-missing'; error?: string }
    | { kind: 'agent-failed'; message?: string }
    | { kind: 'aborted' }
  > {
    const serial = input.serial
    if (!serial) return { kind: 'still-missing', error: failure.error }
    const active = this.getGroupTurn(input.id, groupTurnId)
    if (!active || active.aborted) return { kind: 'aborted' }

    const handle = this.makeGroupHandle(this.createGroupRunRecord(input, groupTurnId, agentName, new Date().toISOString()))
    await runStore.append(handle.record)
    active.runIds.push(handle.record.runId)
    this.runs.set(handle.record.runId, handle)
    handle.write({
      kind: 'meta',
      groupTurnId,
      baseEventSeq,
      runs: [{ agent: agentName, runId: handle.record.runId }],
    })
    emitPhase(handle, 'queued')

    const repairMeta = wrapGroup(
      {
        type: 'meta',
        key: 'serial_protocol_repair',
        value: { groupTurnId, step, agent: agentName, reason: failure.error ?? 'protocol-missing' },
        ts: new Date().toISOString(),
      },
      groupTurnId,
      handle.record.runId,
    )
    await groupThreadStore.appendEvent(input.id, repairMeta)
    handle.write({ kind: 'event', groupTurnId, runId: handle.record.runId, agent: agentName, envelope: repairMeta })
    // step 不变:进度条不该因为补协议而前进。
    handle.write({ kind: 'serial_step', groupTurnId, step, maxSteps: serial.maxSteps, agent: agentName, runId: handle.record.runId })

    // 全量 transcript(不 slice):agent 需要看到自己刚才那条缺协议的回复。
    const transcript = await groupThreadStore.readTranscript(input.id)
    await this.executeGroupMember(
      handle,
      {
        ...input,
        text: this.protocolRepairRequest(serial.participants, agentName, failure),
        useTools: false,
        serialContext: { step, previousAgent },
      },
      cwd,
      transcript,
      summary,
      baseEventSeq,
    )

    if (handle.record.status === 'aborted') return { kind: 'aborted' }
    if (handle.record.status !== 'completed') return { kind: 'agent-failed', message: handle.record.error }
    const activeAfter = this.getGroupTurn(input.id, groupTurnId)
    if (!activeAfter || activeAfter.aborted) return { kind: 'aborted' }

    const repaired = parseSerialDirective(
      this.latestAssistantText(await groupThreadStore.readTranscript(input.id), handle.record.runId),
    )
    return repaired.ok ? { kind: 'repaired', directive: repaired } : { kind: 'still-missing', error: repaired.error }
  }

  private protocolRepairRequest(participants: AgentName[], current: AgentName, failure: SerialDirective): string {
    // 合法接棒目标不含自己(selectNextAgentFromDirective 会拒 next === current),外加 @user 终点。
    const targets = [...participants.filter((a) => a !== current).map((a) => `@${a}`), '@user']
    return [
      `Your previous message is missing a valid protocol block (${failure.error ?? 'protocol-missing'}).`,
      'Do not repeat, revise, or extend your analysis — it has already been recorded.',
      'Reply with exactly these two lines and nothing else:',
      'Next: <one target>',
      'Status: needs-review | needs-changes | consensus | blocked',
      '',
      `Valid Next targets: ${targets.join(', ')} (exactly one).`,
      'Use Next: @user together with Status: consensus if the participants have converged,',
      'or Status: blocked if the discussion needs the user to decide.',
    ].join('\n')
  }

  private async executeSerialGroupTurn(
    input: GroupTurnStartInput,
    cwd: string | null,
    baseEventSeq: number,
    firstHandle: RunHandle,
  ): Promise<void> {
    const serial = input.serial
    if (!serial) return
    const groupTurnId = firstHandle.record.turnId
    let currentHandle: RunHandle | null = firstHandle
    let currentAgent = serial.firstAgent
    let previousAgent: AgentName | undefined
    let completedSteps = 0
    let stopReason: 'no-next-agent' | 'consensus' | 'max-steps' | 'protocol-missing' | 'agent-failed' | 'aborted' = 'max-steps'
    let stopMessage: string | undefined
    let stopDetailStatus: SerialDirective['status'] | undefined
    try {
      const summary = await groupThreadStore.readSummary(input.id)
      for (let step = 1; step <= serial.maxSteps; step++) {
        const active = this.getGroupTurn(input.id, groupTurnId)
        if (!active || active.aborted) {
          stopReason = 'aborted'
          break
        }
        const handle = currentHandle ?? this.makeGroupHandle(this.createGroupRunRecord(input, groupTurnId, currentAgent, new Date().toISOString()))
        if (!currentHandle) {
          await runStore.append(handle.record)
          active.runIds.push(handle.record.runId)
          this.runs.set(handle.record.runId, handle)
          handle.write({ kind: 'meta', groupTurnId, baseEventSeq, runs: [{ agent: currentAgent, runId: handle.record.runId }] })
          emitPhase(handle, 'queued')
        }
        const stepStart = wrapGroup(
          {
            type: 'meta',
            key: 'serial_step_start',
            value: { groupTurnId, step, maxSteps: serial.maxSteps, agent: currentAgent, requestedBy: previousAgent ?? 'user' },
            ts: new Date().toISOString(),
          },
          groupTurnId,
          handle.record.runId,
        )
        await groupThreadStore.appendEvent(input.id, stepStart)
        handle.write({ kind: 'serial_step', groupTurnId, step, maxSteps: serial.maxSteps, agent: currentAgent, runId: handle.record.runId })
        handle.write({ kind: 'event', groupTurnId, runId: handle.record.runId, agent: currentAgent, envelope: stepStart })

        const transcript = (await groupThreadStore.readTranscript(input.id)).slice(0, step === 1 ? baseEventSeq : undefined)
        await this.executeGroupMember(
          handle,
          {
            ...input,
            text: this.serialRequest(input.text, step, serial.maxSteps),
            serialContext: { step, previousAgent },
          },
          cwd,
          transcript,
          summary,
          baseEventSeq,
        )
        completedSteps = step
        if (handle.record.status !== 'completed') {
          stopReason = handle.record.status === 'aborted' ? 'aborted' : 'agent-failed'
          stopMessage = handle.record.error
          break
        }
        const activeAfter = this.getGroupTurn(input.id, groupTurnId)
        if (!activeAfter || activeAfter.aborted) {
          stopReason = 'aborted'
          break
        }
        const latest = this.latestAssistantText(await groupThreadStore.readTranscript(input.id), handle.record.runId)
        let directive = parseSerialDirective(latest)
        if (!directive.ok) {
          // docs/13 §解析优先级 6:先补问一次协议,再决定是否终止。补问不占发言预算。
          const repair = await this.requestProtocolRepairOnce(
            input,
            cwd,
            summary,
            groupTurnId,
            baseEventSeq,
            currentAgent,
            previousAgent,
            step,
            directive,
          )
          if (repair.kind === 'aborted') {
            stopReason = 'aborted'
            break
          }
          if (repair.kind === 'agent-failed') {
            stopReason = 'agent-failed'
            stopMessage = repair.message
            break
          }
          if (repair.kind === 'still-missing') {
            stopReason = 'protocol-missing'
            stopMessage = repair.error ?? directive.error
            break
          }
          directive = repair.directive
        }
        if (serial.stopOnConsensus && directive.status === 'consensus') {
          stopReason = 'consensus'
          stopDetailStatus = directive.status
          break
        }
        if (directive.next === '@user' || directive.status === 'blocked') {
          stopReason = 'no-next-agent'
          stopDetailStatus = directive.status
          break
        }
        const next = selectNextAgentFromDirective(directive, serial.participants, currentAgent)
        if (!next) {
          stopReason = 'no-next-agent'
          break
        }
        previousAgent = currentAgent
        currentAgent = next
        currentHandle = null
      }
      await this.finishSerialTurn(
        input.id,
        groupTurnId,
        stopReason === 'aborted' ? 'aborted' : stopReason === 'agent-failed' || stopReason === 'protocol-missing' ? 'failed' : 'completed',
        stopReason,
        completedSteps,
        stopMessage,
        stopDetailStatus,
      )
    } finally {
      this.archiveGroupTurnReplay(input.id, groupTurnId)
      this.groupTurns.delete(input.id)
    }
  }

  private async finishSerialTurn(
    id: string,
    groupTurnId: string,
    status: 'completed' | 'failed' | 'aborted',
    reason: string,
    steps: number,
    message?: string,
    detailStatus?: SerialDirective['status'],
  ) {
    const now = new Date().toISOString()
    const statusEnv = wrapGroup(
      {
        type: 'meta',
        key: 'serial_turn_status',
        value: { groupTurnId, status, reason, steps, ...(message ? { message } : {}), ...(detailStatus ? { detailStatus } : {}) },
        ts: now,
      },
      groupTurnId,
    )
    await groupThreadStore.appendEvent(id, statusEnv)
    this.writeGroupTurn(id, groupTurnId, { kind: 'event', groupTurnId, envelope: statusEnv })
    const note = wrapGroup(
      {
        type: 'meta',
        key: 'user_notification',
        value: {
          groupTurnId,
          reason,
          steps,
          ...(detailStatus ? { detailStatus } : {}),
          text: serialCompletionNotification(reason, steps, detailStatus),
        },
        ts: now,
      },
      groupTurnId,
    )
    await groupThreadStore.appendEvent(id, note)
    this.writeGroupTurn(id, groupTurnId, { kind: 'event', groupTurnId, envelope: note })
    this.writeGroupTurn(id, groupTurnId, {
      kind: 'done',
      groupTurnId,
      status,
      ...(message ? { message } : {}),
    })
  }

  async startNativeResume(input: NativeStartInput): Promise<{ record: RunRecord; userEnvelope: EventEnvelope }> {
    await this.init()
    const agent = agentForNativeSource(input.source)
    if (!agent || !agent.resumeNative) throw new Error(`source "${input.source}" 不支持原生续写`)
    const agentName = agent.name
    if (!(await agent.isAvailable())) throw new Error(`agent "${agentName}" 不可用(本机未安装/登录对应 CLI)`)
    const detail = await loadSessionDetail(input.source, input.sessionId, input.filePath)
    if (!detail) throw new Error('session not found')

    const turnId = `native_turn_${randomUUID()}`
    const runId = `native_run_${randomUUID()}`
    const startedAt = new Date().toISOString()
    const record: RunRecord = {
      runId,
      kind: 'native-resume',
      status: 'running',
      source: input.source,
      sessionId: input.sessionId,
      turnId,
      agent: agentName,
      startedAt,
    }
    await runStore.append(record)
    const handle = new RunHandle(record)
    const userEnvelope: EventEnvelope = {
      origin: 'native',
      source: input.source,
      sourceEventId: `native:${runId}:user`,
      turnId,
      runId,
      event: {
        type: 'user_text',
        text: input.text,
        ts: startedAt,
        targetAgent: agentName,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      },
    }
    await nativeShadowStore.append(input.source, input.sessionId, runId, userEnvelope)
    handle.write({ kind: 'meta', turnId, runId, native: true })
    emitPhase(handle, 'queued')
    handle.write({ kind: 'event', envelope: userEnvelope })
    this.runs.set(runId, handle)
    void this.executeNativeResume(handle, input, detail.summary.cwd)
    return { record, userEnvelope }
  }

  // Codex app-server continuation:
  // 1) spawn `codex app-server --stdio` + initialize + thread/start(等待 threadId)
  // 2) 拿到 threadId 后返回 readyForNativeOpen promise,后台继续跑 turn/start
  // 3) 调用方等 readyForNativeOpen 后再持久化 NativeLink / 暴露 Desktop deeplink
  // 4) ServerNotification 翻译成 NormalizedEvent 灌到 run.stream
  async startCodexContinuation(input: NativeContinuationInput): Promise<{
    record: RunRecord
    threadId: string
    readyForNativeOpen: Promise<RunRecord>
  }> {
    await this.init()
    const turnId = `native_cont_turn_${randomUUID()}`
    const runId = `native_cont_run_${randomUUID()}`
    const startedAt = new Date().toISOString()

    const startupController = new AbortController()
    const lease = await codexRuntimeManager.acquire(startupController.signal)
    const server = lease.server
    lease.setHandlers({
      onNotification() {},
      onServerRequest(r) {
        server.respond(r.id, {
          error: {
            code: -32601,
            message: `Native continuation does not support server request: ${r.method}`,
          },
        })
      },
      onError() {},
    })

    // thread/start,拿 threadId
    let threadId: string | null = null
    try {
      const res = (await server.request('thread/start', {
        cwd: input.cwd ?? undefined,
      })) as { thread?: { id?: string } }
      threadId = res?.thread?.id ?? null
    } catch (e) {
      lease.release()
      throw new Error(`codex app-server thread/start 失败: ${(e as Error).message}`)
    }
    if (!threadId) {
      lease.release()
      throw new Error('codex app-server 未返回 threadId')
    }

    const record: RunRecord = {
      runId,
      kind: 'native-continuation',
      status: 'running',
      turnId,
      agent: 'codex',
      startedAt,
    }
    let handle: RunHandle
    try {
      await runStore.append(record)
      handle = new RunHandle(record)
      handle.write({ kind: 'meta', turnId, runId, native: true })
      emitPhase(handle, 'queued')
      this.runs.set(runId, handle)
    } catch (err) {
      lease.release()
      throw err
    }

    // Codex Desktop 不会可靠地热刷新由另一个 app-server 进程继续写入的 thread。
    // 因此调用方必须等首轮 turn 完成后再暴露 deeplink,否则 Desktop 会缓存空会话,
    // 直到重启才从 rollout JSONL 重新读到 handoff 内容。
    const readyForNativeOpen = this.executeCodexContinuation(handle, lease, threadId, input)
    return { record, threadId, readyForNativeOpen }
  }

  attach(runId: string, res: ServerResponse): (() => void) | null {
    const handle = this.runs.get(runId)
    if (!handle) return null
    return handle.attach(res)
  }

  cancel(runId: string): boolean {
    const handle = this.runs.get(runId)
    if (!handle) return false
    handle.controller.abort()
    return true
  }

  cancelGroupTurn(id: string, runId?: string): boolean {
    const active = this.groupTurns.get(id)
    if (!active) return false
    active.aborted = true
    for (const id of active.runIds) {
      if (!runId || runId === id) this.cancel(id)
    }
    return true
  }

  resolveApproval(approvalId: string, status: ApprovalDecision): boolean {
    const waiter = this.approvalWaiters.get(approvalId)
    if (!waiter) return false
    this.approvalWaiters.delete(approvalId)
    waiter(status)
    return true
  }

  private async requestApproval(
    handle: RunHandle,
    input: {
      operation: Operation
      reason?: string
      source?: Source
      sessionId?: string
      groupThreadId?: string
      agent: AgentName
      persist: (env: EventEnvelope) => Promise<unknown>
      stream: (env: EventEnvelope) => void
    },
  ): Promise<ApprovalDecision> {
    const { runId, turnId } = handle.record
    // 本 run 内该类操作已被「总是允许」→ 直接放行,不再建卡(docs/12 C2)。
    if (handle.alwaysGrantedKinds.has(input.operation.kind)) return 'approved'
    const approval = await approvalStore.create({
      runId,
      turnId,
      source: input.source,
      sessionId: input.sessionId,
      groupThreadId: input.groupThreadId,
      agent: input.agent,
      operation: input.operation,
      reason: input.reason,
    })
    const required = input.source === 'cockpit' || input.groupThreadId
      ? wrapGroup(
          {
            type: 'meta',
            key: 'approval_required',
            value: approval,
            ts: approval.createdAt,
          },
          turnId,
          runId,
        )
      : wrap(input.source ?? 'cockpit', {
          type: 'meta',
          key: 'approval_required',
          value: approval,
          ts: approval.createdAt,
        }, turnId, runId)
    await input.persist(required)
    input.stream(required)
    emitPhase(handle, 'waiting_approval')
    handle.write({ kind: 'approval_required', approval })

    const status = await new Promise<ApprovalDecision>((resolve) => {
      const signal = handle.controller.signal
      const onAbort = () => {
        this.approvalWaiters.delete(approval.approvalId)
        void approvalStore.expire(approval.approvalId)
        resolve('rejected')
      }
      const wrappedResolve = (value: ApprovalDecision) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      }
      this.approvalWaiters.set(approval.approvalId, wrappedResolve)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    if (status === 'approved_always') handle.alwaysGrantedKinds.add(input.operation.kind)

    // 对外(SSE/落盘 meta)归一为 approved/rejected,scope 单独携带供审计与 UI 展示。
    const uiStatus = status === 'rejected' ? ('rejected' as const) : ('approved' as const)
    const scope = status === 'approved_always' ? 'always' : 'once'
    const resolvedValue = { approvalId: approval.approvalId, status: uiStatus, scope }
    const resolved = input.source === 'cockpit' || input.groupThreadId
      ? wrapGroup(
          {
            type: 'meta',
            key: 'approval_resolved',
            value: resolvedValue,
            ts: new Date().toISOString(),
          },
          turnId,
          runId,
        )
      : wrap(input.source ?? 'cockpit', {
          type: 'meta',
          key: 'approval_resolved',
          value: resolvedValue,
          ts: new Date().toISOString(),
        }, turnId, runId)
    await input.persist(resolved)
    input.stream(resolved)
    handle.write({ kind: 'approval_resolved', approvalId: approval.approvalId, status: uiStatus })
    return status
  }

  private async executeFollowup(handle: RunHandle, input: FollowupStartInput) {
    const { runId, turnId } = handle.record
    try {
      const agent = resolveAgent(input.targetAgent)
      emitPhase(handle, 'warming_runtime')
      if (!(await agent.isAvailable())) {
        throw new Error(`agent "${input.targetAgent}" 不可用(本机未安装/登录对应 CLI)`)
      }
      emitPhase(handle, 'runtime_ready')
      emitPhase(handle, 'building_context')
      const detail = await loadSessionDetail(input.source, input.sessionId, input.filePath)
      // 当前轮的 user_text / run_permissions 在 startFollowup 已落盘,会被 loadSessionDetail 读回;
      // 按 turnId 剔除,保证 contextEvents 只含历史、当前请求只出现在 Current Request(docs/01 §九)。
      const detailEvents = (detail?.events ?? []).filter((env) => env.turnId !== turnId)
      let incrementalOpt: { summary: string; upToSourceEventId: string } | undefined
      if (shouldUseIncrementalForRegistry(detailEvents)) {
        const state = await threadContextStore.readState(input.source, input.sessionId)
        if (state?.checkpoint.upToSourceEventId) {
          const summary = await threadContextStore.readSummary(input.source, input.sessionId)
          if (summary && summary.trim().length > 0) {
            incrementalOpt = { summary, upToSourceEventId: state.checkpoint.upToSourceEventId }
          }
        }
      }
      const toolInputById = new Map<string, unknown>()
      let sawStream = false
      emitPhase(handle, 'starting_turn')
      const nativeLinked =
        input.targetAgent === 'codex' && input.codexAcceleratedMode
          ? {
              scope: {
                kind: 'followup' as const,
                source: input.source,
                sessionId: input.sessionId,
                agent: 'codex' as const,
              },
            }
          : undefined
      for await (const raw of agent.run({
        text: withAttachments(input.text, input.attachments),
        contextEvents: projectContextEvents(
          detailEvents,
          incrementalOpt ? { incremental: incrementalOpt } : undefined,
        ),
        targetAgent: input.targetAgent,
        cwd: detail?.summary.cwd ?? null,
        useTools: input.useTools,
        permissions: input.permissions,
        model: input.model,
        effort: input.effort,
        nativeLinked,
        requestApproval:
          agent.supportsApproval === true &&
          input.permissions.mode !== 'full-access'
            ? (operation, reason) =>
                this.requestApproval(handle, {
                  operation,
                  reason,
                  source: input.source,
                  sessionId: input.sessionId,
                  agent: input.targetAgent,
                  persist: (env) => threadStore.appendEvent(input.source, input.sessionId, env),
                  stream: (env) => handle.write({ kind: 'event', envelope: env }),
                })
            : undefined,
        signal: handle.controller.signal,
      })) {
        if (!sawStream) {
          sawStream = true
          emitPhase(handle, 'streaming')
        }
        let ev = raw
        if (ev.type === 'tool_use') {
          toolInputById.set(ev.id, ev.input)
        } else if (ev.type === 'tool_result') {
          const filtered = filterToolResult(ev.output, toolInputById.get(ev.toolUseId))
          ev = { ...ev, output: filtered.text }
        } else if (ev.type === 'assistant_text' || ev.type === 'thinking') {
          ev = { ...ev, text: redactSecrets(ev.text).text }
        }
        const envelope = wrap(input.source, ev, turnId, runId)
        const isDelta = ev.type === 'assistant_text' && ev.delta === true
        if (!isDelta) await threadStore.appendEvent(input.source, input.sessionId, envelope)
        handle.write({ kind: 'event', envelope })
      }

      if (await handle.finish('completed')) {
        emitPhase(handle, 'completed')
        await threadStore.appendTurnStatus(input.source, input.sessionId, turnId, runId, 'completed')
        handle.write({ kind: 'done', turnId, status: 'completed' })
      }
      scheduleSummaryRefresh(input.source, input.sessionId, input.filePath)
    } catch (err) {
      const aborted = handle.controller.signal.aborted
      const status = aborted ? 'aborted' : 'failed'
      const message = aborted ? 'aborted' : String((err as Error)?.message ?? err)
      if (await handle.finish(status, aborted ? undefined : message)) {
        emitPhase(handle, 'failed')
        await threadStore.appendTurnStatus(input.source, input.sessionId, turnId, runId, status, aborted ? undefined : message)
        handle.write({ kind: aborted ? 'aborted' : 'error', turnId, status, message })
      }
      scheduleSummaryRefresh(input.source, input.sessionId, input.filePath)
    } finally {
      setTimeout(() => {
        if (this.runs.get(runId) === handle) this.runs.delete(runId)
      }, 5 * 60 * 1000).unref?.()
    }
  }

  private async executeGroupMember(
    handle: RunHandle,
    input: GroupTurnStartInput,
    cwd: string | null,
    transcript: EventEnvelope[],
    summary: string,
    baseEventSeq: number,
  ) {
    const { runId, turnId, agent: agentNameForRun } = handle.record
    const agent = resolveAgent(agentNameForRun)
    const toolInputById = new Map<string, unknown>()
    try {
      emitPhase(handle, 'warming_runtime')
      if (!(await agent.isAvailable())) throw new Error(`agent "${agentNameForRun}" 不可用(本机未安装/登录对应 CLI)`)
      emitPhase(handle, 'runtime_ready')
      emitPhase(handle, 'building_context')
      let sawStream = false
      emitPhase(handle, 'starting_turn')
      const nativeLinked =
        agentNameForRun === 'codex' && input.codexAcceleratedMode
          ? {
              scope: {
                kind: 'group-member' as const,
                groupThreadId: input.id,
                agent: 'codex' as const,
              },
            }
          : undefined
      for await (const raw of agent.run({
        text: input.text,
        contextEvents: buildGroupContextEvents(
          transcript,
          summary,
          agentNameForRun,
          input.attachments ?? [],
          input.serial && input.serialContext
            ? {
                participants: input.serial.participants,
                step: input.serialContext.step,
                maxSteps: input.serial.maxSteps,
                preset: input.serial.preset,
                previousAgent: input.serialContext.previousAgent,
              }
            : undefined,
        ),
        targetAgent: agentNameForRun,
        cwd,
        useTools: input.useTools,
        permissions: input.permissions,
        model: input.cliByAgent?.[agentNameForRun]?.model,
        effort: input.cliByAgent?.[agentNameForRun]?.effort,
        nativeLinked,
        requestApproval:
          agent.supportsApproval === true &&
          input.permissions.mode !== 'full-access'
            ? (operation, reason) =>
                this.requestApproval(handle, {
                  operation,
                  reason,
                  source: 'cockpit',
                  groupThreadId: input.id,
                  agent: agentNameForRun,
                  persist: (env) => groupThreadStore.appendEvent(input.id, env),
                  stream: (env) => handle.write({ kind: 'event', groupTurnId: turnId, runId, agent: agentNameForRun, envelope: env }),
                })
            : undefined,
        signal: handle.controller.signal,
      })) {
        if (!sawStream) {
          sawStream = true
          emitPhase(handle, 'streaming')
        }
        let ev = raw
        if (ev.type === 'tool_use') {
          toolInputById.set(ev.id, ev.input)
        } else if (ev.type === 'tool_result') {
          const filtered = filterToolResult(ev.output, toolInputById.get(ev.toolUseId))
          ev = { ...ev, output: filtered.text }
        } else if (ev.type === 'assistant_text' || ev.type === 'thinking') {
          ev = { ...ev, text: redactSecrets(ev.text).text }
        }
        if ('agent' in ev && ev.agent == null) ev = { ...ev, agent: agentNameForRun } as NormalizedEvent
        const envelope = wrapGroup(ev, turnId, runId)
        const isDelta = ev.type === 'assistant_text' && ev.delta === true
        if (!isDelta) await groupThreadStore.appendEvent(input.id, envelope)
        handle.write({ kind: 'event', groupTurnId: turnId, runId, agent: agentNameForRun, envelope })
      }
      if (await handle.finish('completed')) {
        emitPhase(handle, 'completed')
        await groupThreadStore.appendTurnStatus(input.id, turnId, runId, agentNameForRun, baseEventSeq, 'completed')
        handle.write({ kind: 'run_done', groupTurnId: turnId, runId, agent: agentNameForRun, status: 'completed' })
      }
    } catch (err) {
      const aborted = handle.controller.signal.aborted
      const status = aborted ? 'aborted' : 'failed'
      const message = aborted ? undefined : String((err as Error)?.message ?? err)
      if (await handle.finish(status, message)) {
        emitPhase(handle, 'failed')
        await groupThreadStore.appendTurnStatus(input.id, turnId, runId, agentNameForRun, baseEventSeq, status, message)
        handle.write({
          kind: 'run_done',
          groupTurnId: turnId,
          runId,
          agent: agentNameForRun,
          status,
          ...(message ? { message } : {}),
        })
      }
    } finally {
      setTimeout(() => {
        if (this.runs.get(runId) === handle) this.runs.delete(runId)
      }, 5 * 60 * 1000).unref?.()
    }
  }

  private async executeCodexContinuation(
    handle: RunHandle,
    lease: CodexRuntimeLease,
    threadId: string,
    input: NativeContinuationInput,
  ): Promise<RunRecord> {
    const { runId, turnId } = handle.record
    const server = lease.server
    let turnDone = false
    let turnErr: string | null = null
    let providerTurnId: string | null = null
    let interruptTimer: NodeJS.Timeout | null = null
    let sawStream = false
    let settle: (() => void) | null = null
    const done = new Promise<void>((resolve) => {
      settle = resolve
    })

    const finishFromError = (err: Error) => {
      turnErr = String(err.message ?? err)
      settle?.()
    }

    lease.setHandlers({
      onNotification(n) {
        providerTurnId = providerTurnId ?? notificationTurnId(n.params)
        const events = translateNotification(n.method, n.params, threadId)
        for (const ev of events) {
          if (!sawStream) {
            sawStream = true
            emitPhase(handle, 'streaming')
          }
          const envelope: EventEnvelope = {
            origin: 'native',
            source: 'codex',
            sourceEventId: `native:${runId}:${randomUUID()}`,
            turnId,
            runId,
            event: ev,
          }
          handle.write({ kind: 'event', envelope })
        }
        if (n.method === 'turn/completed') {
          turnDone = true
          if (interruptTimer) clearTimeout(interruptTimer)
          settle?.()
        } else if (n.method === 'error') {
          const message = (n.params as any)?.error?.message ?? 'app-server error'
          turnErr = String(message)
          if (interruptTimer) clearTimeout(interruptTimer)
          settle?.()
        }
      },
      onServerRequest(r) {
        server.respond(r.id, {
          error: {
            code: -32601,
            message: `Native continuation does not support server request: ${r.method}`,
          },
        })
      },
      onError: finishFromError,
    })

    const interruptActiveTurn = () => {
      if (!providerTurnId) {
        lease.disposeRuntime(new Error('codex native continuation aborted before turn id'))
        settle?.()
        return
      }
      void server.request('turn/interrupt', { threadId, turnId: providerTurnId }).catch((err) => {
        turnErr = String((err as Error)?.message ?? err)
        lease.disposeRuntime(new Error(`codex native continuation interrupt failed: ${turnErr}`))
        settle?.()
      })
      interruptTimer = setTimeout(() => {
        turnErr = 'aborted'
        lease.disposeRuntime(new Error('codex native continuation interrupt timeout'))
        settle?.()
      }, CODEX_CONTINUATION_INTERRUPT_TIMEOUT_MS)
      interruptTimer.unref?.()
    }

    const onAbort = () => interruptActiveTurn()
    handle.controller.signal.addEventListener('abort', onAbort, { once: true })

    try {
      emitPhase(handle, 'runtime_ready')
      emitPhase(handle, 'starting_turn')
      // 发送 turn。cwd 覆盖只用于必要时;默认沿用 thread cwd。
      const turn = (await server.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: input.prompt, text_elements: [] }],
        ...(input.cwd ? { cwd: input.cwd } : {}),
      })) as { turn?: { id?: string } }
      providerTurnId = turn.turn?.id ?? providerTurnId
      await done
      if (turnErr) throw new Error(turnErr)
      if (!turnDone) throw new Error('turn interrupted')

      if (await handle.finish('completed')) {
        emitPhase(handle, 'completed')
        handle.write({ kind: 'done', turnId, status: 'completed' })
      }
    } catch (err) {
      const aborted = handle.controller.signal.aborted
      const status = aborted ? 'aborted' : 'failed'
      const message = aborted ? 'aborted' : String((err as Error)?.message ?? err)
      if (await handle.finish(status, aborted ? undefined : message)) {
        emitPhase(handle, 'failed')
        handle.write({ kind: aborted ? 'aborted' : 'error', turnId, status, message })
      }
    } finally {
      handle.controller.signal.removeEventListener('abort', onAbort)
      if (interruptTimer) clearTimeout(interruptTimer)
      lease.release()
      setTimeout(() => {
        if (this.runs.get(runId) === handle) this.runs.delete(runId)
      }, 5 * 60 * 1000).unref?.()
    }
    return handle.record
  }

  private async executeNativeResume(handle: RunHandle, input: NativeStartInput, cwd: string | null) {
    const { runId, turnId, agent: agentNameForRun } = handle.record
    const agent = resolveAgent(agentNameForRun)
    try {
      emitPhase(handle, 'runtime_ready')
      emitPhase(handle, 'starting_turn')
      const toolInputById = new Map<string, unknown>()
      let sawOutput = false
      for await (const raw of agent.resumeNative!({
        text: withAttachments(input.text, input.attachments),
        source: input.source,
        sessionId: input.sessionId,
        filePath: input.filePath,
        cwd,
        writeMode: input.writeMode ?? 'read-only',
        effort: input.effort,
        signal: handle.controller.signal,
      })) {
        if (!sawOutput) {
          sawOutput = true
          emitPhase(handle, 'streaming')
        }
        let ev = raw
        if (ev.type === 'tool_use') {
          toolInputById.set(ev.id, ev.input)
        } else if (ev.type === 'tool_result') {
          const filtered = filterToolResult(ev.output, toolInputById.get(ev.toolUseId))
          ev = { ...ev, output: filtered.text }
        } else if (ev.type === 'assistant_text' || ev.type === 'thinking') {
          ev = { ...ev, text: redactSecrets(ev.text).text }
        }
        const envelope = wrapNative(input.source, ev, turnId, runId)
        await nativeShadowStore.append(input.source, input.sessionId, runId, envelope)
        handle.write({ kind: 'event', envelope })
      }
      if (await handle.finish('completed')) {
        emitPhase(handle, 'completed')
        handle.write({ kind: 'done', turnId, status: 'completed' })
      }
    } catch (err) {
      const aborted = handle.controller.signal.aborted
      const status = aborted ? 'aborted' : 'failed'
      const message = aborted ? 'aborted' : String((err as Error)?.message ?? err)
      if (await handle.finish(status, aborted ? undefined : message)) {
        emitPhase(handle, 'failed')
        handle.write({ kind: aborted ? 'aborted' : 'error', turnId, status, message })
      }
    } finally {
      setTimeout(() => {
        if (this.runs.get(runId) === handle) this.runs.delete(runId)
      }, 5 * 60 * 1000).unref?.()
    }
  }
}

export const runRegistry = new RunRegistry()
export const _internal = { RunHandle }
