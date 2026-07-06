import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { EventEnvelope, NormalizedEvent, Source } from '../loaders/types'
import { loadSessionDetail } from '../sessions-service'
import { resolveAgent } from '../adapters/registry'
import type { NativeWriteMode } from '../adapters/types'
import { filterToolResult, redactSecrets } from '../adapters/sensitive'
import { resolveSafe } from './resolve'

function parseWriteMode(raw: unknown): NativeWriteMode {
  // 白名单校验,未知值一律 fallback 到最安全的 read-only。
  return raw === 'trusted' ? 'trusted' : 'read-only'
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

function sseWrite(res: ServerResponse, msg: unknown) {
  res.write(`data: ${JSON.stringify(msg)}\n\n`)
  ;(res as ServerResponse & { flush?: () => void }).flush?.()
}

function sessionAgentOf(source: string): 'claude' | 'codex' | null {
  if (source === 'claude-code') return 'claude'
  if (source === 'codex') return 'codex'
  return null
}

function wrap(source: Source, ev: NormalizedEvent, turnId: string, runId: string): EventEnvelope {
  return {
    origin: 'native',
    source,
    sourceEventId: ev.type === 'tool_use' ? ev.id : `native:${runId}:${randomUUID()}`,
    turnId,
    runId,
    event: ev,
  }
}

async function handlePostNativeMessage(
  req: IncomingMessage,
  res: ServerResponse,
  source: Source,
  id: string,
  filePath: string,
) {
  const body = (await readBody(req)) as { text?: string; writeMode?: unknown }
  const text = (body.text ?? '').trim()
  if (!text) {
    sendJson(res, 400, { error: 'empty message' })
    return
  }
  const writeMode = parseWriteMode(body.writeMode)

  const agentName = sessionAgentOf(source)
  if (!agentName) {
    sendJson(res, 400, { error: `source "${source}" 不支持原生续写` })
    return
  }

  const agent = resolveAgent(agentName)
  if (!agent.canResumeNative?.(source) || !agent.resumeNative) {
    sendJson(res, 400, { error: `agent "${agentName}" 不支持原生续写` })
    return
  }
  if (!(await agent.isAvailable())) {
    sendJson(res, 400, { error: `agent "${agentName}" 不可用(本机未安装/登录对应 CLI)` })
    return
  }

  const detail = await loadSessionDetail(source, id, filePath)
  if (!detail) {
    sendJson(res, 404, { error: 'session not found' })
    return
  }

  res.statusCode = 200
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  req.socket?.setNoDelay?.(true)
  res.flushHeaders?.()

  const turnId = `native_turn_${randomUUID()}`
  const runId = `native_run_${randomUUID()}`
  sseWrite(res, { kind: 'meta', turnId, runId, native: true })

  const now = new Date().toISOString()
  sseWrite(res, {
    kind: 'event',
    envelope: {
      origin: 'native',
      source,
      sourceEventId: `native:${runId}:user`,
      turnId,
      runId,
      event: { type: 'user_text', text, ts: now, targetAgent: agentName },
    } satisfies EventEnvelope,
  })

  const ac = new AbortController()
  let finished = false
  req.on('close', () => {
    if (!finished) ac.abort()
  })

  try {
    const toolInputById = new Map<string, unknown>()
    for await (const raw of agent.resumeNative({
      text,
      source,
      sessionId: id,
      filePath,
      cwd: detail.summary.cwd,
      writeMode,
      signal: ac.signal,
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
      sseWrite(res, { kind: 'event', envelope: wrap(source, ev, turnId, runId) })
    }

    finished = true
    sseWrite(res, { kind: 'done', turnId, status: 'completed', native: true })
    res.end()
  } catch (err) {
    finished = true
    const aborted = ac.signal.aborted
    const status = aborted ? 'aborted' : 'failed'
    const message = aborted ? 'aborted' : String((err as Error)?.message ?? err)
    if (!res.writableEnded) {
      sseWrite(res, { kind: aborted ? 'aborted' : 'error', turnId, status, message, native: true })
      res.end()
    }
  }
}

export async function handleNativeRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const parts = url.pathname.split('/').filter(Boolean) // ['api','native',...]
  if (parts[1] !== 'native') return false

  const source = parts[2] ? decodeURIComponent(parts[2]) : ''
  const id = parts[3] ? decodeURIComponent(parts[3]) : ''

  // POST /api/native/:src/:id/messages
  if (req.method === 'POST' && parts.length === 5 && parts[4] === 'messages') {
    const filePath = await resolveSafe(source, id)
    if (!filePath) {
      sendJson(res, 404, { error: 'session not found' })
      return true
    }
    await handlePostNativeMessage(req, res, source, id, filePath)
    return true
  }

  return false
}
