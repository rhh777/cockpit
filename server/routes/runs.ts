import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AgentName, Source } from '../loaders/types'
import { resolveSafe } from './resolve'
import { runRegistry } from '../runs/run-registry'
import { normalizeAttachments, type AttachmentDraft } from '../util/attachments'
import { threadAttachmentsDir } from '../store/paths'
import { normalizeRunPermissions } from '../permissions/types'

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

function openSse(req: IncomingMessage, res: ServerResponse) {
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  req.socket?.setNoDelay?.(true)
  res.flushHeaders?.()
}

async function handleStartFollowup(req: IncomingMessage, res: ServerResponse, source: Source, id: string) {
  const filePath = await resolveSafe(source, id)
  if (!filePath) {
    sendJson(res, 404, { error: 'session not found' })
    return
  }

  const body = (await readBody(req)) as {
    text?: string
    targetAgent?: AgentName
    useTools?: boolean
    parentTurnId?: string
    model?: string
    effort?: string
    attachments?: AttachmentDraft[]
    permissions?: unknown
    codexAcceleratedMode?: boolean
  }
  const text = (body.text ?? '').trim()
  const attachments = await normalizeAttachments(threadAttachmentsDir(source, id), body.attachments)
  if (!text && attachments.length === 0) {
    sendJson(res, 400, { error: 'empty message' })
    return
  }

  const started = await runRegistry.startFollowup({
    source,
    sessionId: id,
    filePath,
    text,
    targetAgent: body.targetAgent ?? 'claude',
    useTools: body.useTools ?? true,
    permissions: normalizeRunPermissions(body.permissions),
    parentTurnId: body.parentTurnId?.trim() || undefined,
    model: body.model?.trim() || undefined,
    effort: body.effort?.trim() || undefined,
    attachments: attachments.length ? attachments : undefined,
    codexAcceleratedMode: body.codexAcceleratedMode === true,
  })
  sendJson(res, 202, {
    run: started.record,
    userEnvelope: started.userEnvelope,
  })
}

async function handleStartNative(req: IncomingMessage, res: ServerResponse, source: Source, id: string) {
  const filePath = await resolveSafe(source, id)
  if (!filePath) {
    sendJson(res, 404, { error: 'session not found' })
    return
  }
  const body = (await readBody(req)) as { text?: string; attachments?: AttachmentDraft[]; writeMode?: unknown }
  const text = (body.text ?? '').trim()
  const attachments = await normalizeAttachments(threadAttachmentsDir(source, id), body.attachments)
  if (!text && attachments.length === 0) {
    sendJson(res, 400, { error: 'empty message' })
    return
  }
  const writeMode = body.writeMode === 'trusted' ? 'trusted' : 'read-only'
  try {
    const started = await runRegistry.startNativeResume({
      source,
      sessionId: id,
      filePath,
      text,
      attachments: attachments.length ? attachments : undefined,
      writeMode,
    })
    sendJson(res, 202, {
      run: started.record,
      userEnvelope: started.userEnvelope,
    })
  } catch (e) {
    sendJson(res, 400, { error: String((e as Error)?.message ?? e) })
  }
}

export async function handleRunsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  await runRegistry.init()
  const parts = url.pathname.split('/').filter(Boolean)

  // POST /api/sessions/:source/:id/runs
  if (parts[1] === 'sessions' && req.method === 'POST' && parts.length === 5 && parts[4] === 'runs') {
    await handleStartFollowup(req, res, decodeURIComponent(parts[2]) as Source, decodeURIComponent(parts[3]))
    return true
  }

  // POST /api/native/:source/:id/runs
  if (parts[1] === 'native' && req.method === 'POST' && parts.length === 5 && parts[4] === 'runs') {
    await handleStartNative(req, res, decodeURIComponent(parts[2]) as Source, decodeURIComponent(parts[3]))
    return true
  }

  // GET /api/sessions/:source/:id/runs?status=running
  if (parts[1] === 'sessions' && req.method === 'GET' && parts.length === 5 && parts[4] === 'runs') {
    const source = decodeURIComponent(parts[2]) as Source
    const id = decodeURIComponent(parts[3])
    const status = url.searchParams.get('status')
    const runs = status === 'running' || !status ? runRegistry.listRunningForSession(source, id) : []
    sendJson(res, 200, { runs })
    return true
  }

  if (parts[1] !== 'runs') return false

  // GET /api/runs?status=running
  if (req.method === 'GET' && parts.length === 2) {
    const status = url.searchParams.get('status')
    sendJson(res, 200, { runs: status === 'running' || !status ? runRegistry.listRunning() : [] })
    return true
  }

  const runId = parts[2] ? decodeURIComponent(parts[2]) : ''

  // GET /api/runs/:runId/stream
  if (req.method === 'GET' && parts.length === 4 && parts[3] === 'stream') {
    if (!runRegistry.get(runId)) {
      sendJson(res, 404, { error: 'run not found' })
      return true
    }
    openSse(req, res)
    const detach = runRegistry.attach(runId, res)
    req.on('close', () => detach?.())
    return true
  }

  // POST /api/runs/:runId/cancel
  if (req.method === 'POST' && parts.length === 4 && parts[3] === 'cancel') {
    runRegistry.cancel(runId)
    sendJson(res, 202, { ok: true })
    return true
  }

  return false
}
