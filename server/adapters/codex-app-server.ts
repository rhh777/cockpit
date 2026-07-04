// Codex app-server 客户端。docs/07 Phase 2:通过 `codex app-server --stdio`
// 走 newline-delimited JSON-RPC 2.0,创建 thread、发送 turn、把 ServerNotification
// 翻译成 Cockpit 的 NormalizedEvent。
//
// 协议来源:`codex app-server generate-ts --out <dir>`(方法名/字段名以生成物为准)。
// 传输格式:每行一个 JSON 对象;初始化时 params.capabilities 可为 null。
//
// 本模块只做协议编解码和事件翻译;进程生命周期(spawn/abort/exit)由调用方
// (RunRegistry.executeNativeContinuation)按 run 语义驱动。

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import type { NormalizedEvent } from '../loaders/types'
import type { Operation } from '../permissions/types'
import { resolveCodexCommand } from './codex-command'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params: unknown
}
interface JsonRpcResponse {
  jsonrpc?: '2.0'
  id: number | string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}
interface JsonRpcNotification {
  jsonrpc?: '2.0'
  method: string
  params: unknown
}

export type AppServerEvent =
  | { kind: 'thread_started'; threadId: string }
  | { kind: 'normalized'; event: NormalizedEvent }
  | { kind: 'turn_completed' }
  | { kind: 'turn_failed'; message: string }

export type CodexApprovalResponse =
  | { result: unknown }
  | { error: { code: number; message: string; data?: unknown } }

export interface CodexApprovalMapping {
  operation: Operation
  reason?: string
  responseFor(status: 'approved' | 'rejected'): CodexApprovalResponse
}

type Pending = {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

export class CodexAppServer {
  private child: ChildProcessByStdio<Writable, Readable, Readable> | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private stderr = ''
  private stopped = false

  async spawn(): Promise<void> {
    const bin = await resolveCodexCommand()
    if (!bin) throw new Error('codex CLI 不可用(本机未安装/登录对应 CLI)')
    // `--stdio` 是默认 transport,但显式指定更稳。
    const child = spawn(bin, ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child as ChildProcessByStdio<Writable, Readable, Readable>
    child.stderr.on('data', (d) => (this.stderr += String(d)))
    child.on('close', () => {
      this.stopped = true
      for (const { reject } of this.pending.values()) {
        reject(new Error(`codex app-server exited${this.stderr ? `: ${this.stderr.trim()}` : ''}`))
      }
      this.pending.clear()
    })
  }

  onNotification: ((n: JsonRpcNotification) => void) | null = null
  onServerRequest: ((r: JsonRpcRequest) => void) | null = null

  async readLoop(): Promise<void> {
    if (!this.child) throw new Error('not spawned')
    const rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line.trim()) continue
      let msg: JsonRpcResponse | JsonRpcNotification | JsonRpcRequest
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if ('id' in msg && (msg as JsonRpcResponse).result !== undefined) {
        const res = msg as JsonRpcResponse
        const p = this.pending.get(Number(res.id))
        if (p) {
          this.pending.delete(Number(res.id))
          p.resolve(res.result)
        }
        continue
      }
      if ('id' in msg && (msg as JsonRpcResponse).error) {
        const res = msg as JsonRpcResponse
        const p = this.pending.get(Number(res.id))
        if (p) {
          this.pending.delete(Number(res.id))
          p.reject(new Error(res.error!.message || 'app-server error'))
        }
        continue
      }
      if ('method' in msg && !('id' in msg)) {
        this.onNotification?.(msg as JsonRpcNotification)
        continue
      }
      if ('method' in msg && 'id' in msg) {
        // Server-initiated request (approval prompts 等)。Phase 2 只处理 initialize 后
        // 的普通 continuation,不需要主动应答 approval,可直接忽略或回错误。
        this.onServerRequest?.(msg as JsonRpcRequest)
        continue
      }
    }
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (!this.child || this.stopped) return Promise.reject(new Error('app-server stopped'))
    const id = this.nextId++
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.child!.stdin.write(JSON.stringify(req) + '\n', (err) => {
        if (err) {
          this.pending.delete(id)
          reject(err)
        }
      })
    })
  }

  notify(method: string, params?: unknown): void {
    if (!this.child || this.stopped) return
    const notification = params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params }
    this.child.stdin.write(JSON.stringify(notification) + '\n')
  }

  respond(id: number | string, response: CodexApprovalResponse): void {
    if (!this.child || this.stopped) return
    const msg =
      'error' in response
        ? { jsonrpc: '2.0', id, error: response.error }
        : { jsonrpc: '2.0', id, result: response.result }
    this.child.stdin.write(JSON.stringify(msg) + '\n')
  }

  kill(): void {
    if (this.stopped) return
    this.stopped = true
    try {
      this.child?.kill('SIGTERM')
    } catch {
      // ignore
    }
  }

  get childProcess() {
    return this.child
  }
}

function maybeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function firstObjectValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return Object.values(value as Record<string, unknown>).find(
    (v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v),
  )
}

function summarizeFileChange(change: Record<string, unknown> | undefined): 'create' | 'edit' | 'delete' {
  if (change?.type === 'add') return 'create'
  if (change?.type === 'delete') return 'delete'
  return 'edit'
}

export function mapCodexApprovalRequest(method: string, params: any): CodexApprovalMapping | null {
  switch (method) {
    case 'item/commandExecution/requestApproval': {
      const command = maybeString(params?.command) ?? '(unknown command)'
      return {
        operation: { kind: 'shell', command, cwd: maybeString(params?.cwd) ?? null },
        reason: maybeString(params?.reason),
        responseFor(status) {
          return { result: { decision: status === 'approved' ? 'accept' : 'decline' } }
        },
      }
    }
    case 'item/fileChange/requestApproval': {
      const root = maybeString(params?.grantRoot)
      const itemId = maybeString(params?.itemId)
      return {
        operation: {
          kind: 'file_write',
          path: root ?? (itemId ? `Codex file change ${itemId}` : '(pending file change)'),
          action: 'edit',
        },
        reason: maybeString(params?.reason),
        responseFor(status) {
          return { result: { decision: status === 'approved' ? 'accept' : 'decline' } }
        },
      }
    }
    case 'item/permissions/requestApproval': {
      return {
        operation: {
          kind: 'file_write',
          path: maybeString(params?.cwd) ?? '(permission profile)',
          action: 'edit',
        },
        reason: maybeString(params?.reason) ?? 'Codex requests additional permissions for this turn.',
        responseFor(status) {
          if (status === 'approved') {
            return { result: { permissions: params?.permissions ?? {}, scope: 'turn', reviewCommands: true } }
          }
          return { result: { permissions: {}, scope: 'turn', reviewCommands: true } }
        },
      }
    }
    case 'execCommandApproval': {
      const command = Array.isArray(params?.command)
        ? params.command.map((p: unknown) => String(p)).join(' ')
        : maybeString(params?.command) ?? '(unknown command)'
      return {
        operation: { kind: 'shell', command, cwd: maybeString(params?.cwd) ?? null },
        reason: maybeString(params?.reason),
        responseFor(status) {
          return { result: { decision: status === 'approved' ? 'approved' : 'denied' } }
        },
      }
    }
    case 'applyPatchApproval': {
      const fileChanges = params?.fileChanges
      const path = Object.keys(fileChanges ?? {})[0] ?? maybeString(params?.grantRoot) ?? '(patch)'
      const change = firstObjectValue(fileChanges)
      return {
        operation: { kind: 'file_write', path, action: summarizeFileChange(change) },
        reason: maybeString(params?.reason),
        responseFor(status) {
          return { result: { decision: status === 'approved' ? 'approved' : 'denied' } }
        },
      }
    }
    default:
      return null
  }
}

export function codexThreadSettings(input: {
  mode?: 'ask' | 'auto-safe' | 'full-access'
  cwd?: string | null
  model?: string
  effort?: string
  writableRoots?: string[]
}) {
  const mode = input.mode ?? 'ask'
  const approvalPolicy = mode === 'full-access' ? 'never' : 'on-request'
  const approvalsReviewer = mode === 'auto-safe' ? 'auto_review' : 'user'
  const sandboxPolicy =
    mode === 'full-access'
      ? { type: 'dangerFullAccess' }
      : mode === 'auto-safe'
        ? {
            type: 'workspaceWrite',
            writableRoots: input.writableRoots ?? [],
            networkAccess: true,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          }
        : { type: 'readOnly', networkAccess: false }
  return {
    ...(input.cwd ? { cwd: input.cwd } : {}),
    approvalPolicy,
    approvalsReviewer,
    sandboxPolicy,
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
  }
}

// 把 app-server ServerNotification 翻译成 NormalizedEvent。返回 null 表示忽略。
export function translateNotification(method: string, params: any, threadId: string | null): NormalizedEvent[] {
  const ts = new Date().toISOString()
  const events: NormalizedEvent[] = []
  switch (method) {
    case 'item/started': {
      const item = params?.item
      if (!item) return events
      const ev = itemToToolUse(item, ts)
      if (ev) events.push(ev)
      return events
    }
    case 'item/completed': {
      const item = params?.item
      if (!item) return events
      // 文本类
      if (item.type === 'agentMessage') {
        events.push({
          type: 'assistant_text',
          text: String(item.text ?? ''),
          ts,
          agent: 'codex',
          streamId: String(item.id ?? `${threadId ?? params?.threadId ?? 'codex'}:agent`),
        })
        return events
      }
      if (item.type === 'reasoning') {
        const text = Array.isArray(item.content) ? item.content.join('\n') : String(item.content ?? '')
        events.push({ type: 'thinking', text, ts })
        return events
      }
      // 工具类:如果 started 没发出 tool_use(容错),这里补一条。
      const use = itemToToolUse(item, ts)
      const result = itemToToolResult(item, ts)
      if (use) events.push(use)
      if (result) events.push(result)
      return events
    }
    case 'item/agentMessage/delta': {
      const text = String(params?.delta ?? '')
      if (!text) return events
      events.push({
        type: 'assistant_text',
        text,
        ts,
        agent: 'codex',
        streamId: String(params?.itemId ?? params?.messageId ?? params?.id ?? `${threadId ?? params?.threadId ?? 'codex'}:agent`),
        delta: true,
      })
      return events
    }
    case 'turn/completed': {
      const usage = params?.turn?.tokenUsage
      if (usage) {
        events.push({
          type: 'usage',
          inputTokens: Number(usage.inputTokens ?? 0),
          outputTokens: Number(usage.outputTokens ?? 0),
          ts,
          agent: 'codex',
        })
      }
      return events
    }
    case 'thread/started':
      if (threadId) {
        events.push({ type: 'meta', key: 'codex_thread_started', value: { threadId }, ts })
      }
      return events
    case 'error': {
      const message = params?.error?.message ?? 'app-server error'
      events.push({ type: 'meta', key: 'codex_error', value: { message }, ts })
      return events
    }
    default:
      return events
  }
}

function itemToToolUse(item: any, ts: string): NormalizedEvent | null {
  const id = String(item.id ?? `codex_${randomUUID()}`)
  switch (item.type) {
    case 'commandExecution':
      return { type: 'tool_use', id, name: 'shell', input: { command: item.command }, ts, agent: 'codex' }
    case 'mcpToolCall':
      return {
        type: 'tool_use',
        id,
        name: `${item.server}.${item.tool}`,
        input: item.arguments,
        ts,
        agent: 'codex',
      }
    case 'fileChange':
      return { type: 'tool_use', id, name: 'apply_patch', input: { changes: item.changes }, ts, agent: 'codex' }
    case 'webSearch':
      return { type: 'tool_use', id, name: 'web_search', input: { query: item.query }, ts, agent: 'codex' }
    default:
      return null
  }
}

function itemToToolResult(item: any, ts: string): NormalizedEvent | null {
  const id = String(item.id ?? `codex_${randomUUID()}`)
  switch (item.type) {
    case 'commandExecution': {
      const failed = item.status === 'failed' || (item.exitCode != null && item.exitCode !== 0)
      return {
        type: 'tool_result',
        toolUseId: id,
        output: String(item.aggregatedOutput ?? ''),
        isError: !!failed,
        ts,
      }
    }
    case 'mcpToolCall': {
      const failed = item.status === 'failed'
      return {
        type: 'tool_result',
        toolUseId: id,
        output: typeof item.result === 'string' ? item.result : JSON.stringify(item.result ?? ''),
        isError: !!failed,
        ts,
      }
    }
    default:
      return null
  }
}
