import type { ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { AgentName, ChatAttachment, EventEnvelope, NormalizedEvent, Source } from '../loaders/types'
import { resolveAgent } from '../adapters/registry'
import { filterToolResult, redactSecrets } from '../adapters/sensitive'
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
import type { ApprovalRequest, Operation, RunPermissions } from '../permissions/types'

const CODEX_CONTINUATION_INTERRUPT_TIMEOUT_MS = 5_000

// Phase 4 incremental 门槛:原生事件 > 50 或估算文本 > 12000 chars 才切换到 summary 前缀模式。
// 短 session 全量已够,增量反而丢细节。
const INCREMENTAL_EVENT_THRESHOLD = 50
const INCREMENTAL_TEXT_THRESHOLD = 12000

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
  | { kind: 'done'; groupTurnId: string; status: 'completed' | 'partial' | 'failed'; message?: string }

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
  /** 推理强度;缺省由路由决定(当前默认 medium)。 */
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
  private terminal: RunStatus | null = null

  constructor(public record: RunRecord) {}

  write(msg: RunStreamMessage) {
    this.replay.push(msg)
    for (const sub of this.subscribers.values()) sseWrite(sub.res, msg)
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

function sessionAgentOf(source: string): 'claude' | 'codex' | null {
  if (source === 'claude-code') return 'claude'
  if (source === 'codex') return 'codex'
  return null
}

function agentName(agent: AgentName | undefined): string {
  if (agent === 'claude') return 'Claude'
  if (agent === 'codex') return 'Codex'
  if (agent === 'opencode') return 'OpenCode'
  if (agent === 'cursor') return 'Cursor'
  return String(agent)
}

function renderAttachmentLines(attachments?: ChatAttachment[]): string[] {
  if (!attachments?.length) return []
  return [
    '[Attachments]',
    ...attachments.map((a) => {
      const label = a.kind === 'directory' ? 'directory' : a.kind === 'image' ? `image ${a.mimeType}` : 'file'
      const target = a.kind === 'image' ? a.path ?? '[embedded image]' : a.path
      return `- ${label}: ${a.name} -> ${target}`
    }),
  ]
}

// 单会话 follow-up / native 续写没有 group 的 context preview,附件引用行直接拼到当前请求文本里,
// CLI 凭路径读取(图片已落 attachments 目录,file/directory 是原路径)。
function withAttachments(text: string, attachments?: ChatAttachment[]): string {
  const lines = renderAttachmentLines(attachments)
  if (lines.length === 0) return text
  return [text, '', ...lines].join('\n')
}

const GROUP_MESSAGE_HEAD_CHARS = 800
const GROUP_MESSAGE_TAIL_CHARS = 400
const GROUP_MESSAGE_MAX_CHARS = GROUP_MESSAGE_HEAD_CHARS + GROUP_MESSAGE_TAIL_CHARS + 200

function clipGroupMessage(text: string): string {
  if (text.length <= GROUP_MESSAGE_MAX_CHARS) return text
  const head = text.slice(0, GROUP_MESSAGE_HEAD_CHARS)
  const tail = text.slice(text.length - GROUP_MESSAGE_TAIL_CHARS)
  const omitted = text.length - GROUP_MESSAGE_HEAD_CHARS - GROUP_MESSAGE_TAIL_CHARS
  return `${head}\n...[omitted ${omitted} chars]...\n${tail}`
}

function projectGroupContext(
  events: EventEnvelope[],
  summary: string,
  currentText: string,
  targetAgent: AgentName,
  currentAttachments: ChatAttachment[] = [],
): EventEnvelope[] {
  const recent = events
    .filter((env) => env.event.type !== 'meta' && env.event.type !== 'usage')
    .slice(-30)
    .map((env) => {
      const e = env.event
      if (e.type === 'user_text')
        return [`[User]: ${clipGroupMessage(e.text || '(no text)')}`, ...renderAttachmentLines(e.attachments)].join('\n')
      if (e.type === 'assistant_text') return `[${agentName(e.agent)}]: ${clipGroupMessage(e.text)}`
      if (e.type === 'tool_use') return `[${agentName(e.agent)} tool]: ${e.name}`
      if (e.type === 'tool_result') return `[Tool result]: ${e.isError ? 'error' : 'ok'}`
      if (e.type === 'thinking') return `[${agentName(targetAgent)} thinking]: ${clipGroupMessage(e.text)}`
      return null
    })
    .filter((x): x is string => x != null)
    .join('\n')

  const text = [
    '# Cockpit Group Chat',
    '',
    `You are ${agentName(targetAgent)} participating in a local Cockpit group chat.`,
    'Only answer the current request. The transcript below is the Cockpit source of truth.',
    '',
    '## Shared Summary',
    summary.trim() || '(empty)',
    '',
    '## Recent Transcript',
    recent || '(empty)',
    '',
    '## Current Request Preview',
    currentText || '(no text)',
    ...renderAttachmentLines(currentAttachments),
  ].join('\n')

  return [
    {
      origin: 'cockpit',
      source: 'cockpit',
      sourceEventId: `ctx_${randomUUID()}`,
      event: { type: 'user_text', text, ts: new Date().toISOString() },
    },
  ]
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
  private approvalWaiters = new Map<string, (status: 'approved' | 'rejected') => void>()
  private initialized = false

  async init() {
    if (this.initialized) return
    this.initialized = true
    await runStore.markInterruptedOnStartup()
  }

  get(runId: string): RunHandle | undefined {
    return this.runs.get(runId)
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
  }> {
    await this.init()
    const state = await groupThreadStore.readState(input.id)
    if (!state) throw new Error('group thread not found')
    if (input.targetAgents.length > 0 && this.groupTurns.has(input.id)) {
      throw new Error('group turn already running')
    }

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
    if (input.targetAgents.length === 0) {
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
      const handle = new RunHandle(record)
      handle.write({ kind: 'meta', groupTurnId, baseEventSeq, runs: records.map(({ agent, runId }) => ({ agent, runId })) })
      emitPhase(handle, 'queued')
      handle.write({ kind: 'event', groupTurnId, envelope: userEnvelope })
      handle.write({ kind: 'event', groupTurnId, envelope: turnStart })
      this.runs.set(record.runId, handle)
      return handle
    })
    this.groupTurns.set(input.id, { groupTurnId, baseEventSeq, runIds: records.map((r) => r.runId) })

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
  }

  async startNativeResume(input: NativeStartInput): Promise<{ record: RunRecord; userEnvelope: EventEnvelope }> {
    await this.init()
    const agentName = sessionAgentOf(input.source)
    if (!agentName) throw new Error(`source "${input.source}" 不支持原生续写`)
    const agent = resolveAgent(agentName)
    if (!agent.canResumeNative?.(input.source) || !agent.resumeNative) throw new Error(`agent "${agentName}" 不支持原生续写`)
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
  // 2) 拿到 threadId 后立即返回,调用方(handoffs 路由)可持久化 NativeLink
  // 3) 后台内继续跑 turn/start,把 ServerNotification 翻译成 NormalizedEvent 灌到 run.stream
  async startCodexContinuation(input: NativeContinuationInput): Promise<{
    record: RunRecord
    threadId: string
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

    void this.executeCodexContinuation(handle, lease, threadId, input)
    return { record, threadId }
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
    for (const id of active.runIds) {
      if (!runId || runId === id) this.cancel(id)
    }
    return true
  }

  resolveApproval(approvalId: string, status: 'approved' | 'rejected'): boolean {
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
  ): Promise<'approved' | 'rejected'> {
    const { runId, turnId } = handle.record
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

    const status = await new Promise<'approved' | 'rejected'>((resolve) => {
      const signal = handle.controller.signal
      const onAbort = () => {
        this.approvalWaiters.delete(approval.approvalId)
        void approvalStore.expire(approval.approvalId)
        resolve('rejected')
      }
      const wrappedResolve = (value: 'approved' | 'rejected') => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      }
      this.approvalWaiters.set(approval.approvalId, wrappedResolve)
      signal.addEventListener('abort', onAbort, { once: true })
    })

    const resolved = input.source === 'cockpit' || input.groupThreadId
      ? wrapGroup(
          {
            type: 'meta',
            key: 'approval_resolved',
            value: { approvalId: approval.approvalId, status },
            ts: new Date().toISOString(),
          },
          turnId,
          runId,
        )
      : wrap(input.source ?? 'cockpit', {
          type: 'meta',
          key: 'approval_resolved',
          value: { approvalId: approval.approvalId, status },
          ts: new Date().toISOString(),
        }, turnId, runId)
    await input.persist(resolved)
    input.stream(resolved)
    handle.write({ kind: 'approval_resolved', approvalId: approval.approvalId, status })
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
      const detailEvents = detail?.events ?? []
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
          (input.targetAgent === 'codex' || input.targetAgent === 'claude') &&
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
        contextEvents: projectGroupContext(transcript, summary, input.text, agentNameForRun, input.attachments ?? []),
        targetAgent: agentNameForRun,
        cwd,
        useTools: input.useTools,
        permissions: input.permissions,
        model: input.cliByAgent?.[agentNameForRun]?.model,
        effort: input.cliByAgent?.[agentNameForRun]?.effort,
        nativeLinked,
        requestApproval:
          (agentNameForRun === 'codex' || agentNameForRun === 'claude') &&
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
  ) {
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
  }

  private async executeNativeResume(handle: RunHandle, input: NativeStartInput, cwd: string | null) {
    const { runId, turnId, agent: agentNameForRun } = handle.record
    const agent = resolveAgent(agentNameForRun)
    try {
      const toolInputById = new Map<string, unknown>()
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
        handle.write({ kind: 'done', turnId, status: 'completed' })
      }
    } catch (err) {
      const aborted = handle.controller.signal.aborted
      const status = aborted ? 'aborted' : 'failed'
      const message = aborted ? 'aborted' : String((err as Error)?.message ?? err)
      if (await handle.finish(status, aborted ? undefined : message)) {
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
