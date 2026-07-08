import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AgentName } from '../loaders/types'
import { groupAttachmentsDir, groupThreadStore } from '../store/group-thread-store'
import { normalizeAttachments, type AttachmentDraft } from '../util/attachments'
import { sessionRegistry } from '../registry/session-registry'
import { parseMentions } from '../util/mentions'
import { cleanTitle } from '../util/title'
import { runRegistry } from '../runs/run-registry'
import { loadSessionDetail } from '../sessions-service'
import type { Source } from '../loaders/types'
import { normalizeRunPermissions } from '../permissions/types'

// 群聊消息的发送/执行统一走 run-registry(POST /api/group-threads/:id/runs)。
// 本路由负责群聊 thread 的生命周期(创建/导入/改名/删除)与 turn 取消。

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

async function handleFromSession(req: IncomingMessage, res: ServerResponse) {
  const body = (await readBody(req)) as {
    source?: Source
    sessionId?: string
    agents?: AgentName[]
    title?: string
    includeRecentEvents?: number | 'all'
  }
  if (typeof body.source !== 'string' || typeof body.sessionId !== 'string') {
    sendJson(res, 400, { error: 'source and sessionId required' })
    return
  }
  const filePath = await sessionRegistry.resolve(body.source, body.sessionId)
  if (!filePath) {
    sendJson(res, 404, { error: 'source session not found' })
    return
  }
  const detail = await loadSessionDetail(body.source, body.sessionId, filePath)
  if (!detail) {
    sendJson(res, 404, { error: 'source session load failed' })
    return
  }
  const state = await groupThreadStore.create({
    title: body.title?.trim() || detail.summary.title,
    cwd: detail.summary.cwd,
    agents: Array.isArray(body.agents) ? body.agents : undefined,
  })

  const includeAll = body.includeRecentEvents === 'all'
  const includeN = includeAll
    ? Number.POSITIVE_INFINITY
    : Math.max(0, Math.min((body.includeRecentEvents as number) ?? 20, 5000))
  if (includeN > 0) {
    const filtered = detail.events.filter(
      (e) => e.event.type === 'user_text' || e.event.type === 'assistant_text',
    )
    const recent = includeAll ? filtered : filtered.slice(-includeN)
    for (const env of recent) {
      await groupThreadStore.appendEvent(state.id, {
        origin: 'cockpit',
        source: 'cockpit',
        sourceEventId: `import:${body.source}:${body.sessionId}:${env.sourceEventId ?? randomUUID()}`,
        event: env.event,
      })
    }
    await groupThreadStore.appendEvent(state.id, {
      origin: 'cockpit',
      source: 'cockpit',
      sourceEventId: `import-meta:${randomUUID()}`,
      event: {
        type: 'meta',
        key: 'imported_from',
        value: {
          source: body.source,
          sessionId: body.sessionId,
          count: recent.length,
          totalAvailable: filtered.length,
        },
        ts: new Date().toISOString(),
      },
    })
  }
  sessionRegistry.invalidate()
  sendJson(res, 201, { groupThreadId: state.id })
}

async function handleCreate(req: IncomingMessage, res: ServerResponse) {
  const body = (await readBody(req)) as { title?: string; cwd?: string | null; agents?: AgentName[] }
  const state = await groupThreadStore.create({
    title: body.title,
    cwd: typeof body.cwd === 'string' ? body.cwd : process.cwd(),
    agents: Array.isArray(body.agents) ? body.agents : undefined,
  })
  sessionRegistry.invalidate()
  sendJson(res, 201, state)
}

async function handleCancel(res: ServerResponse, id: string, req: IncomingMessage) {
  const body = (await readBody(req)) as { runId?: string }
  runRegistry.cancelGroupTurn(id, body.runId)
  sendJson(res, 202, { ok: true })
}

async function handleStartRun(req: IncomingMessage, res: ServerResponse, id: string) {
  const state = await groupThreadStore.readState(id)
  if (!state) {
    sendJson(res, 404, { error: 'group thread not found' })
    return
  }
  const body = (await readBody(req)) as {
    text?: string
    useTools?: boolean
    targetAgents?: AgentName[]
    cliByAgent?: Partial<Record<AgentName, { model?: string; effort?: string }>>
    attachments?: AttachmentDraft[]
    permissions?: unknown
    codexAcceleratedMode?: boolean
  }
  const text = (body.text ?? '').trim()
  const attachments = await normalizeAttachments(groupAttachmentsDir(id), body.attachments)
  if (!text && attachments.length === 0) {
    sendJson(res, 400, { error: 'empty message' })
    return
  }

  const mentions = parseMentions(text)
  const memberSet = new Set(state.agents)
  const targetAgents = mentions.filter((a) => memberSet.has(a))
  try {
    const started = await runRegistry.startGroupTurn({
      id,
      text,
      targetAgents,
      useTools: body.useTools ?? true,
      permissions: normalizeRunPermissions(body.permissions),
      cliByAgent: body.cliByAgent,
      attachments,
      codexAcceleratedMode: body.codexAcceleratedMode === true,
    })
    if (state.title.trim() === 'Group Chat' && text) {
      const title = cleanTitle(text, 36)
      if (title && title !== state.title) {
        await groupThreadStore.update(id, { title })
        sessionRegistry.invalidate()
      }
    }
    sendJson(res, 202, started)
  } catch (e) {
    const message = String((e as Error)?.message ?? e)
    sendJson(res, message.includes('already running') ? 409 : 400, { error: message })
  }
}

export async function handleGroupThreadsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts[1] !== 'group-threads') return false

  if (req.method === 'POST' && parts.length === 2) {
    await handleCreate(req, res)
    return true
  }

  if (req.method === 'POST' && parts.length === 3 && parts[2] === 'from-session') {
    await handleFromSession(req, res)
    return true
  }

  const id = parts[2] ? decodeURIComponent(parts[2]) : ''

  if (req.method === 'POST' && parts.length === 4 && parts[3] === 'runs') {
    await handleStartRun(req, res, id)
    return true
  }

  if (req.method === 'PATCH' && parts.length === 3) {
    const body = (await readBody(req)) as { title?: string }
    const state = await groupThreadStore.update(id, { title: body.title })
    if (!state) {
      sendJson(res, 404, { error: 'group thread not found' })
      return true
    }
    sessionRegistry.invalidate()
    sendJson(res, 200, state)
    return true
  }

  if (req.method === 'POST' && parts.length === 6 && parts[3] === 'turns' && parts[5] === 'cancel') {
    await handleCancel(res, id, req)
    return true
  }

  if (req.method === 'DELETE' && parts.length === 3) {
    await groupThreadStore.delete(id)
    sessionRegistry.invalidate()
    sendJson(res, 200, { ok: true })
    return true
  }

  return false
}
