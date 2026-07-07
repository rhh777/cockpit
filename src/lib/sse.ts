import type { ApprovalRequest, ChatAttachment, EventEnvelope, RunPermissions } from './types'

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

// POST + SSE。EventSource 不支持 POST body,用 fetch + ReadableStream 手解析 text/event-stream。
export type StreamMessage =
  | { kind: 'meta'; turnId: string; runId: string }
  | { kind: 'run_phase'; turnId: string; runId: string; phase: RunPhase }
  | { kind: 'event'; envelope: EventEnvelope }
  | { kind: 'done'; turnId: string; status: string }
  | { kind: 'aborted'; turnId: string; status: string; message?: string }
  | { kind: 'error'; turnId?: string; status?: string; message?: string }
  | { kind: 'approval_required'; approval: ApprovalRequest }
  | { kind: 'approval_resolved'; approvalId: string; status: 'approved' | 'rejected' }

/** 发送前的附件草稿:本地 file/directory 只带路径,粘贴图片带 base64 dataUrl。 */
export type ChatAttachmentDraft =
  | Pick<ChatAttachment, 'kind' | 'path' | 'name'>
  | { kind: 'imageData'; dataUrl: string; name: string; mimeType: string }

export type GroupStreamMessage =
  | {
      kind: 'meta'
      groupTurnId: string
      baseEventSeq: number
      runs: { agent: string; runId: string }[]
    }
  | { kind: 'run_phase'; groupTurnId: string; runId: string; agent: string; phase: RunPhase }
  | { kind: 'event'; groupTurnId: string; runId?: string; agent?: string; envelope: EventEnvelope }
  | {
      kind: 'run_done'
      groupTurnId: string
      runId: string
      agent: string
      status: 'completed' | 'failed' | 'aborted'
      message?: string
    }
  | { kind: 'summary'; markdown: string; parsed?: unknown }
  | { kind: 'done'; groupTurnId: string; status: 'completed' | 'partial' | 'failed'; message?: string }
  | { kind: 'error'; groupTurnId?: string; message: string }

export interface SendFollowupBody {
  text: string
  targetAgent: string
  useTools?: boolean
  /** 在右栏 thread 内继续追问时,指向该 thread 的根 turnId(同 agent / 同 thread 归一渲染)。 */
  parentTurnId?: string
  /** 可选模型 override(透传 CLI --model)。 */
  model?: string
  /** 推理强度。claude:--effort {low,medium,high,xhigh,max};codex:model_reasoning_effort 同名 + xhigh。 */
  effort?: string
  /** 本轮附件(与群聊一致):图片落 threads/<src>/<id>/attachments,file/directory 只引用路径。 */
  attachments?: ChatAttachmentDraft[]
  /** run 级权限档位。默认 ask。 */
  permissions?: RunPermissions
  /**
   * Phase 2 opt-in:「加速模式」—— 仅 Codex 生效,让本 thread 通过官方 runtime 复用 provider thread。
   * 会导致 Cockpit follow-up 在官方 Codex 侧产生原生 session 副作用(落 ~/.codex/sessions)。
   * 默认关闭,由用户在 composer 里显式勾选、per-thread 记忆。
   */
  codexAcceleratedMode?: boolean
}

export interface RunRecord {
  runId: string
  kind: 'followup' | 'native-resume' | 'group-member' | 'native-continuation'
  status: 'running' | 'completed' | 'failed' | 'aborted' | 'interrupted'
  source?: string
  sessionId?: string
  groupThreadId?: string
  turnId: string
  parentTurnId?: string
  agent: string
  permissions?: RunPermissions
  startedAt: string
  endedAt?: string
  error?: string
}

export type RunStreamMessage = StreamMessage | GroupStreamMessage

async function readSse<T>(
  res: Response,
  onMessage: (msg: T) => void,
): Promise<void> {
  if (!res.ok || !res.body) {
    let detail = `${res.status}`
    try {
      detail = (await res.json()).error ?? detail
    } catch {
      /* ignore */
    }
    throw new Error(detail)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      const line = chunk.split('\n').find((l) => l.startsWith('data:'))
      if (!line) continue
      try {
        onMessage(JSON.parse(line.slice(5).trim()) as T)
      } catch {
        /* 跳过坏帧 */
      }
    }
  }
}

export async function startFollowupRun(
  source: string,
  id: string,
  body: SendFollowupBody,
): Promise<{ run: RunRecord; userEnvelope: EventEnvelope }> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(source)}/${encodeURIComponent(id)}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    let detail = `${res.status}`
    try {
      detail = (await res.json()).error ?? detail
    } catch {
      /* ignore */
    }
    throw new Error(detail)
  }
  return res.json()
}

export async function fetchActiveRuns(source: string, id: string): Promise<RunRecord[]> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(source)}/${encodeURIComponent(id)}/runs?status=running`)
  if (!res.ok) throw new Error(`runs ${res.status}`)
  const json = await res.json()
  return Array.isArray(json.runs) ? json.runs : []
}

export async function attachRunStream(
  runId: string,
  onMessage: (msg: RunStreamMessage) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/stream`, { signal })
  await readSse<RunStreamMessage>(res, onMessage)
}

export async function cancelRun(runId: string): Promise<void> {
  await fetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' })
}

export async function startNativeResumeRun(
  source: string,
  id: string,
  body: { text: string; attachments?: ChatAttachmentDraft[]; writeMode?: 'read-only' | 'trusted' },
): Promise<{ run: RunRecord; userEnvelope: EventEnvelope }> {
  const res = await fetch(`/api/native/${encodeURIComponent(source)}/${encodeURIComponent(id)}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    let detail = `${res.status}`
    try {
      detail = (await res.json()).error ?? detail
    } catch {
      /* ignore */
    }
    throw new Error(detail)
  }
  return res.json()
}

export async function startGroupRun(
  id: string,
  body: {
    text: string
    targetAgents?: string[]
    useTools?: boolean
    cliByAgent?: Partial<Record<string, { model?: string; effort?: string }>>
    attachments?: ChatAttachmentDraft[]
    permissions?: RunPermissions
    /** Phase 2 opt-in:仅 Codex 群聊成员消费,per-group-thread 记忆。 */
    codexAcceleratedMode?: boolean
  },
): Promise<{
  groupTurnId: string
  baseEventSeq: number
  records: RunRecord[]
  userEnvelope: EventEnvelope
  turnStart?: EventEnvelope
}> {
  const res = await fetch(`/api/group-threads/${encodeURIComponent(id)}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    let detail = `${res.status}`
    try {
      detail = (await res.json()).error ?? detail
    } catch {
      /* ignore */
    }
    throw new Error(detail)
  }
  return res.json()
}

export async function postFollowupStream(
  source: string,
  id: string,
  body: SendFollowupBody,
  onMessage: (msg: StreamMessage) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(
    `/api/threads/${encodeURIComponent(source)}/${encodeURIComponent(id)}/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    },
  )
  await readSse<StreamMessage>(res, onMessage)
}

export type SessionStreamMessage =
  | { kind: 'init'; total: number; newEvents: EventEnvelope[] }
  | { kind: 'append'; total: number; newEvents: EventEnvelope[] }
  | { kind: 'reset'; reason: string }
  | { kind: 'heartbeat'; ts: number }

/**
 * 订阅一个 session 的实时增量(Phase 3)。GET + SSE,EventSource 够用,但用
 * fetch+ReadableStream 与其他流式接口保持一致,且能透传 AbortSignal。
 */
export async function subscribeSessionStream(
  source: string,
  id: string,
  since: number,
  onMessage: (msg: SessionStreamMessage) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(
    `/api/sessions/${encodeURIComponent(source)}/${encodeURIComponent(id)}/stream?since=${since}`,
    { signal },
  )
  await readSse<SessionStreamMessage>(res, onMessage)
}

export async function postNativeResumeStream(
  source: string,
  id: string,
  body: { text: string; writeMode?: 'read-only' | 'trusted' },
  onMessage: (msg: StreamMessage) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(
    `/api/native/${encodeURIComponent(source)}/${encodeURIComponent(id)}/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    },
  )
  await readSse<StreamMessage>(res, onMessage)
}

export async function postGroupMessageStream(
  id: string,
  body: {
    text: string
    targetAgents?: string[]
    useTools?: boolean
    cliByAgent?: Partial<Record<string, { model?: string; effort?: string }>>
    attachments?: ChatAttachmentDraft[]
    codexAcceleratedMode?: boolean
  },
  onMessage: (msg: GroupStreamMessage) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/group-threads/${encodeURIComponent(id)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  await readSse<GroupStreamMessage>(res, onMessage)
}
