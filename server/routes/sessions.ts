import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Source } from '../loaders/types'
import { listSessions, loadSessionDetail } from '../sessions-service'
import { getChanges } from '../changes-service'
import { subscribe as subscribeWatcher } from '../watcher/session-watcher'
import { followupsFile } from '../store/paths'
import { revealInFileManager } from '../util/reveal'
import { resolveSafe } from './resolve'

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(json)
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

// 返回 true 表示已处理该请求。
export async function handleSessionsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const parts = url.pathname.split('/').filter(Boolean) // ['api','sessions',...]

  // GET /api/sessions
  if (req.method === 'GET' && parts.length === 2 && parts[1] === 'sessions') {
    const summaries = await listSessions()
    // filePath 是内部字段,不返回给前端
    sendJson(
      res,
      200,
      summaries.map(({ filePath: _omit, ...rest }) => rest),
    )
    return true
  }

  // GET /api/sessions/:source/:id
  if (req.method === 'GET' && parts.length === 4 && parts[1] === 'sessions') {
    const source = decodeURIComponent(parts[2])
    const id = decodeURIComponent(parts[3])
    const filePath = await resolveSafe(source, id)
    if (!filePath) {
      sendJson(res, 404, { error: 'session not found' })
      return true
    }
    const detail = await loadSessionDetail(source, id, filePath)
    if (!detail) {
      sendJson(res, 404, { error: 'session not found' })
      return true
    }
    const { filePath: _omit, ...summary } = detail.summary
    sendJson(res, 200, { ...detail, summary })
    return true
  }

  // POST /api/sessions/:source/:id/reveal
  if (
    req.method === 'POST' &&
    parts.length === 5 &&
    parts[1] === 'sessions' &&
    parts[4] === 'reveal'
  ) {
    const source = decodeURIComponent(parts[2]) as Source
    const id = decodeURIComponent(parts[3])
    const filePath = await resolveSafe(source, id)
    if (!filePath) {
      sendJson(res, 404, { error: 'session not found' })
      return true
    }
    const body = (await readBody(req)) as { target?: string }
    const target = body.target === 'followups' ? followupsFile(source, id) : filePath
    await revealInFileManager(target)
    sendJson(res, 200, { ok: true })
    return true
  }

  // GET /api/sessions/:source/:id/stream?since=N  (Phase 3 实时,SSE)
  if (
    req.method === 'GET' &&
    parts.length === 5 &&
    parts[1] === 'sessions' &&
    parts[4] === 'stream'
  ) {
    const source = decodeURIComponent(parts[2]) as Source
    const id = decodeURIComponent(parts[3])
    const filePath = await resolveSafe(source, id)
    if (!filePath) {
      sendJson(res, 404, { error: 'session not found' })
      return true
    }
    await handleSessionStream(req, res, source, id, filePath, url)
    return true
  }

  // GET /api/sessions/:source/:id/changes?sinceEventCount=N  (Phase 1.5 契约,Phase 1 桩)
  if (
    req.method === 'GET' &&
    parts.length === 5 &&
    parts[1] === 'sessions' &&
    parts[4] === 'changes'
  ) {
    const source = decodeURIComponent(parts[2])
    const id = decodeURIComponent(parts[3])
    const filePath = await resolveSafe(source, id)
    if (!filePath) {
      sendJson(res, 404, { error: 'session not found' })
      return true
    }
    const since = Number(url.searchParams.get('sinceEventCount') ?? '0') || 0
    const result = await getChanges(source, id, filePath, since)
    sendJson(res, 200, result)
    return true
  }

  return false
}

async function handleSessionStream(
  req: IncomingMessage,
  res: ServerResponse,
  source: Source,
  id: string,
  filePath: string,
  url: URL,
) {
  const since = Math.max(0, Number(url.searchParams.get('since') ?? '0') || 0)

  res.statusCode = 200
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  req.socket?.setNoDelay?.(true)
  res.flushHeaders?.()

  const write = (msg: unknown) => {
    if (res.writableEnded) return
    res.write(`data: ${JSON.stringify(msg)}\n\n`)
    ;(res as ServerResponse & { flush?: () => void }).flush?.()
  }

  // 1) 立即对齐 since → 当前状态(只读一次,后续靠 watcher 推增量)。
  try {
    const result = await getChanges(source, id, filePath, since)
    if (result.reset || result.total < since) {
      write({ kind: 'reset', reason: 'since-out-of-range' })
    } else {
      write({ kind: 'init', total: result.total, newEvents: result.newEvents })
    }
  } catch (e) {
    write({ kind: 'reset', reason: 'load-error' })
  }

  // 2) 订阅 watcher,推后续 append / reset。
  const unsubscribe = subscribeWatcher(source, id, filePath, (msg) => {
    if (msg.kind === 'append') {
      write({ kind: 'append', total: msg.total, newEvents: msg.newEvents })
    } else {
      write({ kind: 'reset', reason: msg.reason })
    }
  })

  // 3) 心跳,避免 nginx / 反向代理把 idle 连接干掉(MVP 本地用不上,留口)。
  const heartbeat = setInterval(() => write({ kind: 'heartbeat', ts: Date.now() }), 15000)

  const cleanup = () => {
    clearInterval(heartbeat)
    unsubscribe()
    if (!res.writableEnded) res.end()
  }

  req.on('close', cleanup)
  req.on('error', cleanup)
}
