import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import type { AgentName, ChatAttachment, EventEnvelope, NormalizedEvent } from '../loaders/types'
import { resolveAgent } from '../adapters/registry'
import { filterToolResult, redactSecrets } from '../adapters/sensitive'
import { groupAttachmentsDir, groupThreadStore } from '../store/group-thread-store'
import { sessionRegistry } from '../registry/session-registry'
import { parseMentions } from '../util/mentions'
import { cleanTitle } from '../util/title'

type RunStatus = 'running' | 'completed' | 'failed' | 'aborted'

interface ActiveRun {
  runId: string
  agent: AgentName
  controller: AbortController
  status: RunStatus
}

interface ActiveGroupTurn {
  groupTurnId: string
  baseEventSeq: number
  runs: ActiveRun[]
}

const activeTurns = new Map<string, ActiveGroupTurn>()
const IMAGE_MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

type AttachmentDraft =
  | { kind: 'file'; path?: string; name?: string }
  | { kind: 'directory'; path?: string; name?: string }
  | { kind: 'imageData'; dataUrl?: string; name?: string; mimeType?: string }

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
  if (res.writableEnded) return
  res.write(`data: ${JSON.stringify(msg)}\n\n`)
  ;(res as ServerResponse & { flush?: () => void }).flush?.()
}

function wrap(ev: NormalizedEvent, turnId: string, runId?: string): EventEnvelope {
  return {
    origin: 'cockpit',
    source: 'cockpit',
    sourceEventId: ev.type === 'tool_use' ? ev.id : `evt_${randomUUID()}`,
    turnId,
    runId,
    event: ev,
  }
}

function agentName(agent: AgentName | undefined): string {
  return agent === 'codex' ? 'Codex' : agent === 'claude' ? 'Claude' : String(agent)
}

function attachmentName(filePath: string, fallback = 'attachment'): string {
  return path.basename(filePath) || fallback
}

function renderAttachmentLines(attachments?: ChatAttachment[]): string[] {
  if (!attachments?.length) return []
  return [
    '[Attachments]',
    ...attachments.map((a) => {
      const label = a.kind === 'directory' ? 'directory' : a.kind === 'image' ? `image ${a.mimeType}` : 'file'
      return `- ${label}: ${a.name} -> ${a.path}`
    }),
  ]
}

async function normalizeAttachments(id: string, drafts: AttachmentDraft[] | undefined): Promise<ChatAttachment[]> {
  if (!Array.isArray(drafts) || drafts.length === 0) return []
  const out: ChatAttachment[] = []
  for (const draft of drafts.slice(0, 12)) {
    if (draft?.kind === 'file' || draft?.kind === 'directory') {
      if (typeof draft.path !== 'string' || !draft.path.trim()) continue
      const resolved = path.resolve(draft.path)
      let st
      try {
        st = await fs.stat(resolved)
      } catch {
        continue
      }
      if (draft.kind === 'file' && !st.isFile()) continue
      if (draft.kind === 'directory' && !st.isDirectory()) continue
      out.push({
        kind: draft.kind,
        path: resolved,
        name: typeof draft.name === 'string' && draft.name.trim() ? draft.name.trim() : attachmentName(resolved),
      })
    } else if (draft?.kind === 'imageData') {
      const mimeType = typeof draft.mimeType === 'string' ? draft.mimeType : ''
      const ext = IMAGE_MIME_EXT[mimeType]
      const dataUrl = typeof draft.dataUrl === 'string' ? draft.dataUrl : ''
      const marker = `data:${mimeType};base64,`
      if (!ext || !dataUrl.startsWith(marker)) continue
      const bytes = Buffer.from(dataUrl.slice(marker.length), 'base64')
      if (bytes.length === 0 || bytes.length > 20 * 1024 * 1024) continue
      const dir = groupAttachmentsDir(id)
      await fs.mkdir(dir, { recursive: true })
      const safeName = (draft.name?.trim() || `screenshot-${Date.now()}${ext}`).replace(/[^\w.\- ]+/g, '_')
      const filePath = path.join(dir, `${randomUUID()}-${safeName.endsWith(ext) ? safeName : `${safeName}${ext}`}`)
      await fs.writeFile(filePath, bytes)
      out.push({ kind: 'image', path: filePath, name: path.basename(filePath), mimeType })
    }
  }
  return out
}

function projectContext(
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
      if (e.type === 'user_text') {
        return [`[User]: ${e.text || '(no text)'}`, ...renderAttachmentLines(e.attachments)].join('\n')
      }
      if (e.type === 'assistant_text') return `[${agentName(e.agent)}]: ${e.text}`
      if (e.type === 'tool_use') return `[${agentName(e.agent)} tool]: ${e.name}`
      if (e.type === 'tool_result') return `[Tool result]: ${e.isError ? 'error' : 'ok'}`
      if (e.type === 'thinking') return `[${agentName(targetAgent)} thinking]: ${e.text}`
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

function overallStatus(statuses: RunStatus[]): 'completed' | 'partial' | 'failed' {
  const completed = statuses.filter((s) => s === 'completed').length
  if (completed === statuses.length) return 'completed'
  if (completed > 0) return 'partial'
  return 'failed'
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

async function handlePostMessage(req: IncomingMessage, res: ServerResponse, id: string) {
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
  }
  const text = (body.text ?? '').trim()
  const attachments = await normalizeAttachments(id, body.attachments)
  if (!text && attachments.length === 0) {
    sendJson(res, 400, { error: 'empty message' })
    return
  }

  const mentions = parseMentions(text)
  const memberSet = new Set(state.agents)
  const targetAgents = mentions.filter((a) => memberSet.has(a))
  if (targetAgents.length > 0 && activeTurns.has(id)) {
    sendJson(res, 409, { error: 'group turn already running' })
    return
  }

  res.statusCode = 200
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  req.socket?.setNoDelay?.(true)
  res.flushHeaders?.()

  const groupTurnId = `turn_${randomUUID()}`
  const now = () => new Date().toISOString()
  const userEnvelope = wrap(
    { type: 'user_text', text, ts: now(), targetAgents, mentions, ...(attachments.length ? { attachments } : {}) },
    groupTurnId,
  )
  const baseEventSeq = await groupThreadStore.appendEvent(id, userEnvelope)
  if (state.title.trim() === 'Group Chat' && text) {
    const title = cleanTitle(text, 36)
    if (title && title !== state.title) {
      await groupThreadStore.update(id, { title })
      sessionRegistry.invalidate()
    }
  }
  sseWrite(res, { kind: 'event', groupTurnId, envelope: userEnvelope })

  if (targetAgents.length === 0) {
    sseWrite(res, { kind: 'done', groupTurnId, status: 'completed' })
    res.end()
    return
  }

  const runs = targetAgents.map((agent) => ({
    runId: `run_${randomUUID()}`,
    agent,
    turnId: groupTurnId,
    baseEventSeq,
    status: 'running' as const,
  }))
  const turnStart = wrap(
    {
      type: 'meta',
      key: 'turn_start',
      value: { groupTurnId, baseEventSeq, targetAgents, runs },
      ts: now(),
    },
    groupTurnId,
  )
  await groupThreadStore.appendEvent(id, turnStart)
  sseWrite(res, { kind: 'meta', groupTurnId, baseEventSeq, runs: runs.map(({ agent, runId }) => ({ agent, runId })) })
  sseWrite(res, { kind: 'event', groupTurnId, envelope: turnStart })

  const active: ActiveGroupTurn = {
    groupTurnId,
    baseEventSeq,
    runs: runs.map((r) => ({ runId: r.runId, agent: r.agent, controller: new AbortController(), status: 'running' })),
  }
  activeTurns.set(id, active)

  let closed = false
  req.on('close', () => {
    if (closed) return
    for (const run of active.runs) run.controller.abort()
  })

  const transcript = (await groupThreadStore.readTranscript(id)).slice(0, baseEventSeq)
  const summary = await groupThreadStore.readSummary(id)
  const useTools = body.useTools ?? true
  const cliByAgent = body.cliByAgent ?? {}

  const runOne = async (run: ActiveRun) => {
    const agent = resolveAgent(run.agent)
    const toolInputById = new Map<string, unknown>()
    try {
      if (!(await agent.isAvailable())) {
        throw new Error(`agent "${run.agent}" 不可用(本机未安装/登录对应 CLI)`)
      }
      for await (const raw of agent.run({
        text,
        contextEvents: projectContext(transcript, summary, text, run.agent, attachments),
        targetAgent: run.agent,
        cwd: state.cwd,
        useTools,
        model: cliByAgent[run.agent]?.model,
        effort: cliByAgent[run.agent]?.effort,
        signal: run.controller.signal,
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
        if ('agent' in ev && ev.agent == null) ev = { ...ev, agent: run.agent } as NormalizedEvent
        const envelope = wrap(ev, groupTurnId, run.runId)
        const isDelta = ev.type === 'assistant_text' && ev.delta === true
        if (!isDelta) await groupThreadStore.appendEvent(id, envelope)
        sseWrite(res, { kind: 'event', groupTurnId, runId: run.runId, agent: run.agent, envelope })
      }
      run.status = 'completed'
      await groupThreadStore.appendTurnStatus(id, groupTurnId, run.runId, run.agent, baseEventSeq, 'completed')
      sseWrite(res, { kind: 'run_done', groupTurnId, runId: run.runId, agent: run.agent, status: 'completed' })
    } catch (err) {
      const aborted = run.controller.signal.aborted
      run.status = aborted ? 'aborted' : 'failed'
      const message = aborted ? undefined : String((err as Error)?.message ?? err)
      await groupThreadStore.appendTurnStatus(id, groupTurnId, run.runId, run.agent, baseEventSeq, run.status, message)
      sseWrite(res, {
        kind: 'run_done',
        groupTurnId,
        runId: run.runId,
        agent: run.agent,
        status: run.status,
        ...(message ? { message } : {}),
      })
    }
  }

  await Promise.all(active.runs.map(runOne))
  activeTurns.delete(id)
  closed = true
  const status = overallStatus(active.runs.map((r) => r.status))
  sseWrite(res, { kind: 'done', groupTurnId, status })
  sessionRegistry.invalidate()
  res.end()
}

async function handleCancel(res: ServerResponse, id: string, groupTurnId: string, req: IncomingMessage) {
  const active = activeTurns.get(id)
  if (!active || active.groupTurnId !== groupTurnId) {
    sendJson(res, 204, { ok: true })
    return
  }
  const body = (await readBody(req)) as { runId?: string }
  for (const run of active.runs) {
    if (!body.runId || body.runId === run.runId) run.controller.abort()
  }
  sendJson(res, 202, { ok: true })
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

  const id = parts[2] ? decodeURIComponent(parts[2]) : ''

  if (req.method === 'POST' && parts.length === 4 && parts[3] === 'messages') {
    await handlePostMessage(req, res, id)
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
    await handleCancel(res, id, decodeURIComponent(parts[4]), req)
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
