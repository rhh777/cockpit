// OpenCode adapter uses the official SDK to run an ephemeral OpenCode server session.
import type { LlmToolContent, ModelRef, OpencodeClient, PermissionV2Reply, V2Event } from '@opencode-ai/sdk/v2'
import type { NormalizedEvent } from '../loaders/types'
import { openCodePermissionRuleset } from '../permissions/adapter-policy'
import type { ApprovalDecision, Operation } from '../permissions/types'
import { stringifyToolResult } from '../util/jsonl'
import { commandExists } from './cli-utils'
import { openCodeRuntimeManager } from './opencode-runtime-manager'
import { serializeForAgent } from './serialize'
import type { AgentRunInput, NativeResumeInput, ReviewAgent } from './types'

type QueueItem = { kind: 'event'; event: V2Event } | { kind: 'done' } | { kind: 'error'; error: Error }
export interface AgentModelOption {
  value: string
  label: string
  hint?: string
}

class AsyncQueue {
  private items: QueueItem[] = []
  private waiters: Array<(item: QueueItem) => void> = []

  push(item: QueueItem): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter(item)
    else this.items.push(item)
  }

  next(signal: AbortSignal): Promise<QueueItem> {
    const item = this.items.shift()
    if (item) return Promise.resolve(item)
    if (signal.aborted) return Promise.resolve({ kind: 'error', error: new Error('aborted') })
    return new Promise((resolve) => {
      const waiter = (nextItem: QueueItem) => {
        signal.removeEventListener('abort', onAbort)
        resolve(nextItem)
      }
      const onAbort = () => {
        const idx = this.waiters.indexOf(waiter)
        if (idx >= 0) this.waiters.splice(idx, 1)
        resolve({ kind: 'error', error: new Error('aborted') })
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }
}

function iso(ts?: number): string {
  if (!ts) return new Date().toISOString()
  return new Date(ts < 1_000_000_000_000 ? ts * 1000 : ts).toISOString()
}

function modelRef(raw?: string, variant?: string): ModelRef | undefined {
  if (!raw) return undefined
  const [providerID, ...rest] = raw.split('/')
  const id = rest.join('/')
  if (!providerID || !id) return undefined
  return { providerID, id, ...(variant ? { variant } : {}) }
}

function contentToText(content: LlmToolContent[] | undefined, fallback?: unknown): string {
  const chunks = (content ?? []).map((part) => {
    if (part.type === 'text') return part.text
    if (part.type === 'file') return `[file ${part.name ?? part.uri}]`
    return stringifyToolResult(part)
  })
  if (chunks.length) return chunks.join('\n')
  if (typeof fallback === 'string') return fallback
  if (fallback != null) return stringifyToolResult(fallback)
  return ''
}

function eventSessionID(event: V2Event): string | undefined {
  const props = eventPayload(event)
  return typeof props?.sessionID === 'string' ? props.sessionID : undefined
}

function eventPayload(event: V2Event): Record<string, any> {
  const raw = event as any
  const value = raw.properties ?? raw.data ?? {}
  return value && typeof value === 'object' ? value : {}
}

function normalizeOpenCodeSdkEvent(event: V2Event): NormalizedEvent[] {
  const props = eventPayload(event)
  switch (event.type) {
    case 'session.next.text.delta':
      return [
        {
          type: 'assistant_text',
          text: String(props.delta ?? ''),
          delta: true,
          streamId: String(props.textID ?? props.assistantMessageID ?? event.id),
          ts: iso(props.timestamp),
          agent: 'opencode',
        },
      ]
    case 'session.next.text.ended':
      return [
        {
          type: 'assistant_text',
          text: String(props.text ?? ''),
          streamId: String(props.textID ?? props.assistantMessageID ?? event.id),
          ts: iso(props.timestamp),
          agent: 'opencode',
        },
      ]
    case 'session.next.reasoning.delta':
      return []
    case 'session.next.reasoning.ended':
      return [
        {
          type: 'thinking',
          text: String(props.text ?? ''),
          ts: iso(props.timestamp),
        },
      ]
    case 'session.next.tool.called':
      return [
        {
          type: 'tool_use',
          id: String(props.callID ?? event.id),
          name: String(props.tool ?? 'tool'),
          input: props.input ?? {},
          ts: iso(props.timestamp),
          agent: 'opencode',
        },
      ]
    case 'session.next.tool.success':
      return [
        {
          type: 'tool_result',
          toolUseId: String(props.callID ?? event.id),
          output: contentToText(props.content, props.result),
          isError: false,
          ts: iso(props.timestamp),
        },
      ]
    case 'session.next.tool.failed':
      return [
        {
          type: 'tool_result',
          toolUseId: String(props.callID ?? event.id),
          output: contentToText(undefined, props.result ?? props.error),
          isError: true,
          ts: iso(props.timestamp),
        },
      ]
    case 'session.next.step.ended': {
      const tokens = props.tokens
      if (!tokens || typeof tokens !== 'object') return []
      return [
        {
          type: 'usage',
          inputTokens: Number(tokens.input ?? 0),
          outputTokens: Number(tokens.output ?? 0),
          ts: iso(props.timestamp),
          agent: 'opencode',
        },
      ]
    }
    case 'session.error':
      return [
        {
          type: 'meta',
          key: 'opencode_error',
          value: props.error ?? props,
          ts: iso(props.timestamp),
        },
      ]
    default:
      return []
  }
}

function openCodePermissionOperation(event: V2Event, cwd: string): { operation: Operation; reason: string } {
  const props = eventPayload(event)
  const action = String(props.action ?? props.permission ?? 'permission')
  const resources = Array.isArray(props.resources) ? props.resources.map(String) : Array.isArray(props.patterns) ? props.patterns.map(String) : []
  const metadata = props.metadata && typeof props.metadata === 'object' ? props.metadata : {}
  const lower = action.toLowerCase()
  const first = resources[0]
  const reason = [action, resources.join(', ')].filter(Boolean).join(': ')

  if (lower.includes('bash') || lower.includes('shell') || lower.includes('command')) {
    return {
      operation: { kind: 'shell', command: String((metadata as any).command ?? first ?? action), cwd },
      reason,
    }
  }
  if (lower.includes('web') || lower.includes('network') || lower.includes('fetch')) {
    const value = first ?? String((metadata as any).url ?? '')
    return { operation: { kind: 'network', url: value || undefined, host: value || undefined }, reason }
  }
  if (lower.includes('edit') || lower.includes('write') || lower.includes('delete')) {
    const actionKind = lower.includes('delete') ? 'delete' : lower.includes('write') ? 'create' : 'edit'
    return { operation: { kind: 'file_write', path: first ?? cwd, action: actionKind }, reason }
  }
  if (lower.includes('read') || lower.includes('grep') || lower.includes('glob') || lower.includes('list')) {
    return { operation: { kind: 'file_read', path: first ?? cwd }, reason }
  }
  return { operation: { kind: 'shell', command: `${action} ${resources.join(' ')}`.trim(), cwd }, reason }
}

function replyForDecision(decision: ApprovalDecision): PermissionV2Reply {
  if (decision === 'approved_always') return 'always'
  if (decision === 'approved') return 'once'
  return 'reject'
}

async function replyToPermission(input: {
  client: OpencodeClient
  event: V2Event
  cwd: string
  requestApproval?: AgentRunInput['requestApproval']
}): Promise<void> {
  const props = eventPayload(input.event)
  const requestID = String(props.id ?? '')
  const sessionID = String(props.sessionID ?? '')
  if (!requestID || !sessionID) return

  let decision: ApprovalDecision
  if (input.requestApproval) {
    const mapped = openCodePermissionOperation(input.event, input.cwd)
    decision = await input.requestApproval(mapped.operation, mapped.reason)
  } else {
    decision = 'rejected'
  }

  await input.client.v2.session.permission.reply({
    sessionID,
    requestID,
    reply: replyForDecision(decision),
    ...(decision === 'rejected' ? { message: 'Rejected by user' } : {}),
  })
}

async function assertSdkResult<T>(
  promise: Promise<(({ data: T; error: undefined } | { data: undefined; error: unknown }) & object)>,
): Promise<T> {
  const result = await promise
  if (result.error) throw new Error(stringifyToolResult(result.error))
  if (result.data === undefined) throw new Error('OpenCode SDK response did not include data')
  return result.data
}

async function waitForSessionIdle(client: OpencodeClient, sessionID: string, signal: AbortSignal): Promise<void> {
  let seenActive = false
  while (!signal.aborted) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    const active = await assertSdkResult(client.v2.session.active())
    const sessions = (active as any).data
    const isActive = !!sessions && typeof sessions === 'object' && sessionID in sessions
    if (isActive) seenActive = true
    else if (seenActive) return
  }
  throw new Error('aborted')
}

async function updateSessionPermissions(input: {
  client: OpencodeClient
  sessionID: string
  permissions: AgentRunInput['permissions']
}): Promise<void> {
  const ruleset = openCodePermissionRuleset(input.permissions)
  await assertSdkResult(input.client.session.update({ sessionID: input.sessionID, permission: ruleset }))
}

function startEventPump(input: {
  client: OpencodeClient
  queue: AsyncQueue
  signal: AbortSignal
}): void {
  void (async () => {
    try {
      const sse = await input.client.v2.event.subscribe({ signal: input.signal, sseMaxRetryAttempts: 0 })
      for await (const event of sse.stream) {
        input.queue.push({ kind: 'event', event: event as unknown as V2Event })
      }
      input.queue.push({ kind: 'done' })
    } catch (err) {
      if (!input.signal.aborted) {
        input.queue.push({ kind: 'error', error: err instanceof Error ? err : new Error(String(err)) })
      }
    }
  })()
}

async function* runOpenCodeSdk(input: AgentRunInput): AsyncGenerator<NormalizedEvent> {
  const prompt = serializeForAgent(input.contextEvents, input.text, 'opencode')
  const cwd = input.cwd ?? process.cwd()
  const lease = await openCodeRuntimeManager.acquire()
  const client = lease.clientFor(cwd)
  const streamController = new AbortController()
  const onAbort = () => streamController.abort()
  input.signal.addEventListener('abort', onAbort, { once: true })

  try {
    const session = await assertSdkResult(
      client.v2.session.create({
        agent: input.permissions?.mode === 'ask' && !input.requestApproval ? 'plan' : undefined,
        location: { directory: cwd },
        model: modelRef(input.model, input.effort),
      }),
    )
    const sessionID = session.data.id
    await updateSessionPermissions({ client, sessionID, permissions: input.permissions })

    const queue = new AsyncQueue()
    startEventPump({ client, queue, signal: streamController.signal })

    const promptPromise = assertSdkResult(
      client.v2.session.prompt({
        sessionID,
        prompt: { text: prompt },
        delivery: 'queue',
        resume: true,
      }),
    )
    void promptPromise.catch((err) => {
      queue.push({ kind: 'error', error: err instanceof Error ? err : new Error(String(err)) })
    })
    void promptPromise
      .then(() => waitForSessionIdle(client, sessionID, input.signal))
      .then(() => queue.push({ kind: 'done' }))
      .catch((err) => {
        queue.push({ kind: 'error', error: err instanceof Error ? err : new Error(String(err)) })
      })

    while (!input.signal.aborted) {
      const item = await queue.next(input.signal)
      if (item.kind === 'error') throw item.error
      if (item.kind === 'done') break
      if (eventSessionID(item.event) !== sessionID) continue
      if (item.event.type === 'permission.v2.asked' || item.event.type === 'permission.asked') {
        await replyToPermission({ client, event: item.event, cwd, requestApproval: input.requestApproval })
        continue
      }
      for (const ev of normalizeOpenCodeSdkEvent(item.event)) yield ev
      if (item.event.type === 'session.idle') break
    }
    await promptPromise
    if (input.signal.aborted) {
      await client.v2.session.interrupt({ sessionID }).catch(() => undefined)
      throw new Error('aborted')
    }
  } finally {
    input.signal.removeEventListener('abort', onAbort)
    streamController.abort()
    lease.release()
  }
}

async function* resumeOpenCodeNative(input: NativeResumeInput): AsyncGenerator<NormalizedEvent> {
  if (input.source !== 'opencode') {
    throw new Error('OpenCode native resume 只能用于 OpenCode session')
  }

  const cwd = input.cwd ?? process.cwd()
  const lease = await openCodeRuntimeManager.acquire()
  const client = lease.clientFor(cwd)
  const streamController = new AbortController()
  const onAbort = () => streamController.abort()
  input.signal.addEventListener('abort', onAbort, { once: true })

  try {
    await updateSessionPermissions({
      client,
      sessionID: input.sessionId,
      permissions:
        input.writeMode === 'trusted'
          ? { mode: 'full-access', allowNetwork: true, allowWorkspaceWrite: true, allowOutsideWorkspaceWrite: true, allowShell: true }
          : { mode: 'ask', allowNetwork: false, allowWorkspaceWrite: false, allowOutsideWorkspaceWrite: false, allowShell: false },
    })

    const queue = new AsyncQueue()
    startEventPump({ client, queue, signal: streamController.signal })

    const promptPromise = assertSdkResult(
      client.v2.session.prompt({
        sessionID: input.sessionId,
        prompt: { text: input.text },
        delivery: 'queue',
        resume: true,
      }),
    )
    void promptPromise.catch((err) => {
      queue.push({ kind: 'error', error: err instanceof Error ? err : new Error(String(err)) })
    })
    void promptPromise
      .then(() => waitForSessionIdle(client, input.sessionId, input.signal))
      .then(() => queue.push({ kind: 'done' }))
      .catch((err) => {
        queue.push({ kind: 'error', error: err instanceof Error ? err : new Error(String(err)) })
      })

    while (!input.signal.aborted) {
      const item = await queue.next(input.signal)
      if (item.kind === 'error') throw item.error
      if (item.kind === 'done') break
      if (eventSessionID(item.event) !== input.sessionId) continue
      if (item.event.type === 'permission.v2.asked' || item.event.type === 'permission.asked') {
        await replyToPermission({ client, event: item.event, cwd })
        continue
      }
      for (const ev of normalizeOpenCodeSdkEvent(item.event)) yield ev
      if (item.event.type === 'session.idle') break
    }
    await promptPromise
    if (input.signal.aborted) {
      await client.v2.session.interrupt({ sessionID: input.sessionId }).catch(() => undefined)
      throw new Error('aborted')
    }
  } finally {
    input.signal.removeEventListener('abort', onAbort)
    streamController.abort()
    lease.release()
  }
}

interface OpenCodeProviderInfo {
  id: string
  name?: string
  models?: Record<string, { id?: string; name?: string; status?: string }>
}

function providerEntries(value: unknown): OpenCodeProviderInfo[] {
  if (Array.isArray(value)) return value as OpenCodeProviderInfo[]
  if (!value || typeof value !== 'object') return []
  const raw = value as {
    providers?: unknown
    all?: unknown
    data?: unknown
  }
  if (Array.isArray(raw.providers)) return raw.providers as OpenCodeProviderInfo[]
  if (Array.isArray(raw.all)) return raw.all as OpenCodeProviderInfo[]
  if (Array.isArray(raw.data)) return raw.data as OpenCodeProviderInfo[]
  if (raw.data && typeof raw.data === 'object') return providerEntries(raw.data)
  return []
}

export async function listOpenCodeModels(cwd?: string | null): Promise<AgentModelOption[]> {
  const lease = await openCodeRuntimeManager.acquire()
  try {
    const client = lease.clientFor(cwd ?? process.cwd())
    let data: unknown
    try {
      data = await assertSdkResult((client as any).config.providers())
    } catch {
      data = await assertSdkResult(client.v2.provider.list())
    }
    const raw = data && typeof data === 'object' ? (data as { connected?: string[] }) : {}
    const connected = new Set(raw.connected ?? [])
    const options: AgentModelOption[] = []
    for (const provider of providerEntries(data)) {
      if (!provider.id || !provider.models) continue
      if (connected.size > 0 && !connected.has(provider.id)) continue
      for (const [modelID, model] of Object.entries(provider.models)) {
        if (model.status === 'deprecated') continue
        const id = model.id || modelID
        options.push({
          value: `${provider.id}/${id}`,
          label: model.name || id,
          hint: provider.name || provider.id,
        })
      }
    }
    return options.sort((a, b) => {
      const ah = a.hint ?? ''
      const bh = b.hint ?? ''
      return ah === bh ? a.label.localeCompare(b.label) : ah.localeCompare(bh)
    })
  } finally {
    lease.release()
  }
}

export const opencodeAdapter: ReviewAgent = {
  name: 'opencode',
  displayName: 'OpenCode',
  supportsApproval: true,

  async isAvailable() {
    return commandExists('opencode', ['--version'])
  },

  async warmup() {
    return openCodeRuntimeManager.warmup()
  },

  async *run(input: AgentRunInput): AsyncGenerator<NormalizedEvent> {
    yield* runOpenCodeSdk(input)
  },

  canResumeNative(source: string) {
    return source === 'opencode'
  },

  async *resumeNative(input: NativeResumeInput): AsyncGenerator<NormalizedEvent> {
    yield* resumeOpenCodeNative(input)
  },
}
