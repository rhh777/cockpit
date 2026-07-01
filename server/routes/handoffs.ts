import type { IncomingMessage, ServerResponse } from 'node:http'
import { buildContext, currentSourceSnapshot } from '../handoffs/context-builder'
import { buildCodexDeeplink } from '../handoffs/codex-deeplink'
import { handoffDir, handoffStore } from '../store/handoff-store'
import { revealInFileManager } from '../util/reveal'
import type {
  CreateHandoffInput,
  HandoffSourceRef,
  NativeLink,
  NativeOpenMethod,
  NativeProvider,
} from '../handoffs/types'
import { randomUUID } from 'node:crypto'

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

function validateSourceRef(raw: unknown): HandoffSourceRef | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.kind === 'group-thread' && typeof o.groupThreadId === 'string') {
    return { kind: 'group-thread', groupThreadId: o.groupThreadId }
  }
  if (
    (o.kind === 'native-session' || o.kind === 'cockpit-followup') &&
    typeof o.source === 'string' &&
    typeof o.sessionId === 'string'
  ) {
    return { kind: o.kind, source: o.source, sessionId: o.sessionId }
  }
  return null
}

async function handleCreate(req: IncomingMessage, res: ServerResponse) {
  const body = (await readBody(req)) as Partial<CreateHandoffInput> & { source?: unknown }
  const sourceRef = validateSourceRef(body.source)
  if (!sourceRef) {
    sendJson(res, 400, { error: 'invalid source' })
    return
  }
  const target = body.target === 'codex' || body.target === 'claude' || body.target === 'both' ? body.target : 'both'

  let context
  try {
    context = await buildContext({
      source: sourceRef,
      target,
      currentRequest: typeof body.currentRequest === 'string' ? body.currentRequest : undefined,
      transcriptMode: body.transcriptMode,
    })
  } catch (e) {
    sendJson(res, 404, { error: String((e as Error)?.message ?? e) })
    return
  }
  const manifest = await handoffStore.create({ sourceRef, context })
  sendJson(res, 201, manifest)
}

async function handleGet(res: ServerResponse, id: string) {
  const manifest = await handoffStore.readManifest(id)
  if (!manifest) {
    sendJson(res, 404, { error: 'handoff not found' })
    return
  }
  const ref = manifestToRef(manifest)
  const current = ref ? await currentSourceSnapshot(ref) : null
  const detail = await handoffStore.detail(id, current)
  sendJson(res, 200, detail)
}

function manifestToRef(m: Awaited<ReturnType<typeof handoffStore.readManifest>>): HandoffSourceRef | null {
  if (!m) return null
  const s = m.source
  if (s.kind === 'group-thread' && s.groupThreadId) {
    return { kind: 'group-thread', groupThreadId: s.groupThreadId }
  }
  if ((s.kind === 'native-session' || s.kind === 'cockpit-followup') && s.source && s.sessionId) {
    return { kind: s.kind, source: s.source, sessionId: s.sessionId }
  }
  return null
}

async function handleOpenNative(req: IncomingMessage, res: ServerResponse, id: string) {
  const body = (await readBody(req)) as {
    provider?: NativeProvider
    method?: NativeOpenMethod | 'auto'
  }
  if (body.provider !== 'codex' && body.provider !== 'claude') {
    sendJson(res, 400, { error: 'invalid provider' })
    return
  }
  const manifest = await handoffStore.readManifest(id)
  if (!manifest) {
    sendJson(res, 404, { error: 'handoff not found' })
    return
  }

  // Phase 1: 仅 codex deeplink + claude manual。其它方法返回 501。
  if (body.provider === 'codex') {
    const requested = body.method ?? 'auto'
    if (requested !== 'auto' && requested !== 'deeplink') {
      sendJson(res, 501, { error: `codex method '${requested}' not implemented in Phase 1` })
      return
    }
    const built = buildCodexDeeplink(manifest)
    const link: NativeLink = {
      id: `nl_${randomUUID()}`,
      provider: 'codex',
      handoffId: id,
      createdAt: new Date().toISOString(),
      method: 'deeplink',
      linkLevel: 'none',
      cwd: manifest.cwd,
      status: built.overBudget ? 'failed' : 'created',
      url: built.overBudget ? undefined : built.url,
      error: built.overBudget ? 'prompt exceeds deeplink budget' : undefined,
    }
    const next = await handoffStore.appendNativeLink(id, link)
    sendJson(res, 200, {
      nativeLink: next?.nativeLinks.at(-1) ?? link,
      fallbackPrompt: built.overBudget ? built.prompt : undefined,
    })
    return
  }

  // Claude:Phase 1 默认返回 manual prompt。
  if (body.method && body.method !== 'auto' && body.method !== 'manual') {
    sendJson(res, 501, { error: `claude method '${body.method}' not implemented in Phase 1` })
    return
  }
  const link: NativeLink = {
    id: `nl_${randomUUID()}`,
    provider: 'claude',
    handoffId: id,
    createdAt: new Date().toISOString(),
    method: 'manual',
    linkLevel: 'none',
    cwd: manifest.cwd,
    status: 'created',
  }
  const next = await handoffStore.appendNativeLink(id, link)
  const fallbackPrompt = await readFile(manifest.files.entries.claude)
  sendJson(res, 200, {
    nativeLink: next?.nativeLinks.at(-1) ?? link,
    fallbackPrompt,
  })
}

async function readFile(p: string): Promise<string> {
  try {
    const fsp = await import('node:fs/promises')
    return await fsp.readFile(p, 'utf8')
  } catch {
    return ''
  }
}

export async function handleHandoffsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts[1] !== 'handoffs') return false

  if (req.method === 'POST' && parts.length === 2) {
    await handleCreate(req, res)
    return true
  }
  const id = parts[2] ? decodeURIComponent(parts[2]) : ''
  if (req.method === 'GET' && parts.length === 3) {
    await handleGet(res, id)
    return true
  }
  if (req.method === 'POST' && parts.length === 4 && parts[3] === 'open-native') {
    await handleOpenNative(req, res, id)
    return true
  }
  if (req.method === 'POST' && parts.length === 4 && parts[3] === 'reveal') {
    const manifest = await handoffStore.readManifest(id)
    if (!manifest) {
      sendJson(res, 404, { error: 'handoff not found' })
      return true
    }
    await revealInFileManager(handoffDir(id))
    sendJson(res, 200, { ok: true })
    return true
  }
  return false
}
