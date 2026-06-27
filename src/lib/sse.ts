import type { EventEnvelope } from './types'

// POST + SSE。EventSource 不支持 POST body,用 fetch + ReadableStream 手解析 text/event-stream。
export type StreamMessage =
  | { kind: 'meta'; turnId: string; runId: string }
  | { kind: 'event'; envelope: EventEnvelope }
  | { kind: 'done'; turnId: string; status: string }
  | { kind: 'aborted'; turnId: string; status: string; message?: string }
  | { kind: 'error'; turnId?: string; status?: string; message?: string }

import type { ChatAttachment } from './types'

export type GroupStreamMessage =
  | {
      kind: 'meta'
      groupTurnId: string
      baseEventSeq: number
      runs: { agent: string; runId: string }[]
    }
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
    // SSE 事件以空行分隔
    let idx: number
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      const line = chunk.split('\n').find((l) => l.startsWith('data:'))
      if (!line) continue
      try {
        onMessage(JSON.parse(line.slice(5).trim()) as StreamMessage)
      } catch {
        /* 跳过坏帧 */
      }
    }
  }
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
  if (!res.ok || !res.body) {
    throw new Error(`stream ${res.status}`)
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
        onMessage(JSON.parse(line.slice(5).trim()) as SessionStreamMessage)
      } catch {
        /* 跳过坏帧 */
      }
    }
  }
}

export async function postNativeResumeStream(
  source: string,
  id: string,
  body: { text: string },
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
        onMessage(JSON.parse(line.slice(5).trim()) as StreamMessage)
      } catch {
        /* 跳过坏帧 */
      }
    }
  }
}

export async function postGroupMessageStream(
  id: string,
  body: {
    text: string
    targetAgents?: string[]
    useTools?: boolean
    cliByAgent?: Partial<Record<string, { model?: string; effort?: string }>>
    attachments?: Array<
      | Pick<ChatAttachment, 'kind' | 'path' | 'name'>
      | { kind: 'imageData'; dataUrl: string; name: string; mimeType: string }
    >
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
        onMessage(JSON.parse(line.slice(5).trim()) as GroupStreamMessage)
      } catch {
        /* 跳过坏帧 */
      }
    }
  }
}
