// cockpit 按 docs/01 §七用本机 `codex exec` 子进程调用,不装 @openai/codex-sdk。
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import type { NormalizedEvent } from '../loaders/types'
import { serializeForAgent } from './serialize'
import type { AgentRunInput, NativeResumeInput, ReviewAgent } from './types'
import { resolveCodexCommand } from './codex-command'
import {
  codexThreadSettings,
  mapCodexApprovalRequest,
  translateNotification,
} from './codex-app-server'
import { codexRuntimeManager, type CodexRuntimeLease } from './codex-runtime-manager'
import {
  providerThreadLinkStore,
  type CockpitScope,
  type ProviderThreadLink,
} from '../store/provider-thread-link-store'
import type { Source } from '../loaders/types'

// `codex exec --json` 输出的是 codex-sdk ThreadEvent JSONL(不是 rollout 会话格式),
// 顶层 {type:'item.started'|'item.completed'|'item.updated', item:{type:...}}。
// 我们把工具类拆成两阶段:item.started → tool_use(让 UI 立刻显示"工具被调用"),
// item.completed → tool_result(填进结果)。文本类(agent_message/reasoning)只在 completed 时 emit。
const TOOL_ITEM_TYPES = new Set([
  'command_execution',
  'mcp_tool_call',
  'file_change',
  'web_search',
])

const CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS = 5000

function toolUseFromItem(item: Record<string, any>, ts: string): NormalizedEvent | null {
  const id = String(item.id ?? `codex_${Date.now()}`)
  switch (item.type) {
    case 'command_execution':
      return { type: 'tool_use', id, name: 'shell', input: { command: item.command }, ts, agent: 'codex' }
    case 'mcp_tool_call':
      return {
        type: 'tool_use',
        id,
        name: `${item.server}.${item.tool}`,
        input: item.arguments,
        ts,
        agent: 'codex',
      }
    case 'file_change':
      return { type: 'tool_use', id, name: 'apply_patch', input: { changes: item.changes }, ts, agent: 'codex' }
    case 'web_search':
      return { type: 'tool_use', id, name: 'web_search', input: { query: item.query }, ts, agent: 'codex' }
    default:
      return null
  }
}

function toolResultFromItem(item: Record<string, any>, ts: string): NormalizedEvent | null {
  const id = String(item.id ?? `codex_${Date.now()}`)
  switch (item.type) {
    case 'command_execution': {
      const failed = item.status === 'failed' || (item.exit_code != null && item.exit_code !== 0)
      return {
        type: 'tool_result',
        toolUseId: id,
        output: String(item.aggregated_output ?? ''),
        isError: !!failed,
        ts,
      }
    }
    case 'mcp_tool_call': {
      const failed = item.status === 'failed'
      return {
        type: 'tool_result',
        toolUseId: id,
        output: typeof item.result === 'string' ? item.result : JSON.stringify(item.result ?? ''),
        isError: !!failed,
        ts,
      }
    }
    case 'file_change':
      // 只读沙箱下 file_change 不会真正落盘;不补 tool_result。
      return null
    case 'web_search':
      // web_search 没有显式结果项,结束就算完成。
      return null
    default:
      return null
  }
}

function translateCompletedNonTool(item: Record<string, any>, ts: string): NormalizedEvent[] {
  switch (item.type) {
    case 'agent_message':
      return [{ type: 'assistant_text', text: String(item.text ?? ''), ts, agent: 'codex' }]
    case 'reasoning':
      return [{ type: 'thinking', text: String(item.text ?? ''), ts }]
    case 'error':
      return [{ type: 'meta', key: 'codex_error', value: { message: item.message }, ts }]
    default:
      return [{ type: 'meta', key: `codex_${item.type}`, value: item, ts }]
  }
}

class AsyncEventQueue<T> {
  private values: T[] = []
  private waiters: Array<(next: IteratorResult<T>) => void> = []
  private ended = false
  private error: Error | null = null

  push(value: T) {
    if (this.ended) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value, done: false })
    else this.values.push(value)
  }

  close(error?: Error) {
    if (this.ended) return
    this.ended = true
    this.error = error ?? null
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as T, done: true })
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.values.length > 0) return { value: this.values.shift()!, done: false }
    if (this.ended) {
      if (this.error) throw this.error
      return { value: undefined as T, done: true }
    }
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      const next = await this.next()
      if (next.done) return
      yield next.value
    }
  }
}

function notificationThreadId(params: unknown): string | null {
  if (!params || typeof params !== 'object') return null
  const value = (params as Record<string, unknown>).threadId
  return typeof value === 'string' && value.length > 0 ? value : null
}

function notificationTurnId(params: unknown): string | null {
  if (!params || typeof params !== 'object') return null
  const topLevel = (params as Record<string, unknown>).turnId
  if (typeof topLevel === 'string' && topLevel.length > 0) return topLevel
  const turn = (params as Record<string, unknown>).turn
  if (!turn || typeof turn !== 'object') return null
  const nested = (turn as Record<string, unknown>).id
  return typeof nested === 'string' && nested.length > 0 ? nested : null
}

// Phase 2:native-linked 模式下把 Cockpit scope 映射成 provider-thread-link scope。
function toLinkScope(input: AgentRunInput): CockpitScope | null {
  const s = input.nativeLinked?.scope
  if (!s) return null
  if (s.kind === 'followup') {
    return { kind: 'followup', source: s.source as Source, sessionId: s.sessionId, agent: s.agent }
  }
  return { kind: 'group-member', groupThreadId: s.groupThreadId, agent: s.agent }
}

async function* runCodexAppServer(input: AgentRunInput): AsyncGenerator<NormalizedEvent> {
  // full-access 模式没有 requestApproval,但 app-server 偶发也会发起权限询问(比如 shell 网络):
  // 自动放行以保持"用户已经在 UI 上明确选择 full-access"的语义。有回调时优先走回调。
  const requestApproval = input.requestApproval ?? (async () => 'approved' as const)
  const prompt = serializeForAgent(input.contextEvents, input.text, 'codex')
  let lease: CodexRuntimeLease | null = null
  const linkScope = toLinkScope(input)
  const threadKey = {
    cwd: input.cwd,
    model: input.model,
    effort: input.effort,
    permissionMode: input.permissions?.mode,
    writableRoots: input.writableRoots,
  }
  // native-linked 模式且已有 active link → 尝试直接复用 thread;失败会回退到新建。
  let reusedLink: ProviderThreadLink | null = null
  if (linkScope) {
    reusedLink = await providerThreadLinkStore.findActive('codex', linkScope, threadKey)
  }

  const queue = new AsyncEventQueue<NormalizedEvent>()
  let threadId: string | null = null
  let turnId: string | null = null
  let turnDone = false
  let turnError: string | null = null
  let interruptTimer: NodeJS.Timeout | null = null
  let settle: (() => void) | null = null
  const done = new Promise<void>((resolve) => {
    settle = resolve
  })

  const closeAfterAbortTimeout = () => {
    if (turnDone) return
    turnError = 'aborted'
    lease?.disposeRuntime(new Error('codex app-server interrupt timeout'))
    queue.close(new Error('aborted'))
    settle?.()
  }

  const interruptActiveTurn = () => {
    const activeLease = lease
    if (!activeLease || !threadId || !turnId) {
      activeLease?.disposeRuntime(new Error('codex app-server aborted before turn id'))
      queue.close(new Error('aborted'))
      settle?.()
      return
    }
    void activeLease.server.request('turn/interrupt', { threadId, turnId }).catch((err) => {
      turnError = String((err as Error)?.message ?? err)
      activeLease.disposeRuntime(new Error(`codex app-server interrupt failed: ${turnError}`))
      queue.close(new Error('aborted'))
      settle?.()
    })
    interruptTimer = setTimeout(
      closeAfterAbortTimeout,
      CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS,
    )
    interruptTimer.unref?.()
  }

  const onAbort = () => {
    interruptActiveTurn()
  }
  input.signal.addEventListener('abort', onAbort, { once: true })

  try {
    lease = await codexRuntimeManager.acquire(input.signal)
    const server = lease.server
    lease.setHandlers({
      onNotification(n) {
        const eventThreadId = notificationThreadId(n.params)
        const eventTurnId = notificationTurnId(n.params)
        if (eventThreadId) threadId = threadId ?? eventThreadId
        if (eventTurnId) turnId = turnId ?? eventTurnId

        for (const ev of translateNotification(n.method, n.params, eventThreadId ?? threadId)) queue.push(ev)
        if (n.method === 'turn/completed') {
          turnDone = true
          if (interruptTimer) clearTimeout(interruptTimer)
          settle?.()
        } else if (n.method === 'error') {
          turnError = String((n.params as any)?.error?.message ?? 'app-server error')
          if (interruptTimer) clearTimeout(interruptTimer)
          settle?.()
        }
      },
      onServerRequest(r) {
        void (async () => {
          const mapping = mapCodexApprovalRequest(r.method, r.params)
          if (!mapping) {
            server.respond(r.id, {
              error: { code: -32601, message: `Unsupported Codex server request: ${r.method}` },
            })
            return
          }
          try {
            const status = await requestApproval(mapping.operation, mapping.reason)
            server.respond(r.id, mapping.responseFor(status))
          } catch (err) {
            server.respond(r.id, {
              error: { code: -32000, message: String((err as Error)?.message ?? err) },
            })
          }
        })()
      },
      onError(err) {
        turnError = String(err.message ?? err)
        queue.close(err)
        settle?.()
      },
    })

    const settings = codexThreadSettings({
      mode: input.permissions?.mode,
      cwd: input.cwd,
      model: input.model,
      effort: input.effort,
      writableRoots: input.writableRoots,
    })
    const sandbox =
      input.permissions?.mode === 'full-access'
        ? 'danger-full-access'
        : input.permissions?.mode === 'auto-safe'
          ? 'workspace-write'
          : 'read-only'

    // native-linked 模式:非 ephemeral,让官方 runtime 落原生 session,后续轮可复用。
    // 普通 follow-up:ephemeral=true,不产生原生副作用(docs/11 §Phase 2 A/B 边界)。
    const ephemeral = !linkScope

    if (reusedLink) {
      // 复用已有 thread。跳过 thread/start;失败时 (thread not found) 会重建。
      threadId = reusedLink.nativeThreadId
    } else {
      const thread = (await server.request('thread/start', {
        ...settings,
        sandbox,
        ephemeral,
      })) as { thread?: { id?: string } }
      threadId = thread.thread?.id ?? null
      if (!threadId) throw new Error('codex app-server 未返回 threadId')
      if (linkScope) {
        await providerThreadLinkStore.upsert({
          provider: 'codex',
          scope: linkScope,
          threadKey,
          nativeThreadId: threadId,
          persistence: 'native-linked',
          sourceFingerprint: { eventCount: input.contextEvents.length },
        })
      }
    }

    let turn: { turn?: { id?: string } }
    try {
      turn = (await server.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt, text_elements: [] }],
        ...settings,
      })) as { turn?: { id?: string } }
    } catch (err) {
      // native-linked 复用时如果 thread not found,标记 link failed 并重建一次。
      const msg = String((err as Error)?.message ?? err).toLowerCase()
      const threadMissing =
        reusedLink != null && (msg.includes('not found') || msg.includes('unknown thread') || msg.includes('no such thread'))
      if (!threadMissing) throw err
      await providerThreadLinkStore.markStatus('codex', reusedLink!.id, 'failed')
      const rebuilt = (await server.request('thread/start', {
        ...settings,
        sandbox,
        ephemeral: false,
      })) as { thread?: { id?: string } }
      threadId = rebuilt.thread?.id ?? null
      if (!threadId) throw new Error('codex app-server 未返回 threadId(重建后)')
      if (linkScope) {
        await providerThreadLinkStore.upsert({
          provider: 'codex',
          scope: linkScope,
          threadKey,
          nativeThreadId: threadId,
          persistence: 'native-linked',
          sourceFingerprint: { eventCount: input.contextEvents.length },
        })
      }
      turn = (await server.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt, text_elements: [] }],
        ...settings,
      })) as { turn?: { id?: string } }
    }
    turnId = turn.turn?.id ?? turnId

    void done.then(() => queue.close())
    for await (const ev of queue) yield ev

    if (input.signal.aborted) throw new Error('aborted')
    if (turnError) throw new Error(turnError)
    if (!turnDone) throw new Error('turn interrupted')
  } finally {
    input.signal.removeEventListener('abort', onAbort)
    if (interruptTimer) clearTimeout(interruptTimer)
    lease?.release()
  }
}

export const codexAdapter: ReviewAgent = {
  name: 'codex',

  async isAvailable() {
    // 注意:codex 的 vendored 二进制可能缺失 → spawn ENOENT,这里能检出。
    return (await resolveCodexCommand()) !== null
  },

  async warmup() {
    // 预热 app-server 长驻进程:spawn + initialize,不发 turn,不创建 thread。
    // 触发点:/api/settings/warmup(app 启动、session focus、AgentPicker 切到 Codex)。
    try {
      await codexRuntimeManager.warmup()
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: String((err as Error)?.message ?? err) }
    }
  },

  async *run(input: AgentRunInput): AsyncGenerator<NormalizedEvent> {
    // 统一走 app-server:文字逐 token(agentMessage/delta)、工具事件立刻可见,和群聊 / 有审批
    // follow-up 一致。full-access 由 runCodexAppServer 内部自动放行 approval。
    yield* runCodexAppServer(input)
  },

  canResumeNative(source: string) {
    return source === 'codex'
  },

  async *resumeNative(input: NativeResumeInput): AsyncGenerator<NormalizedEvent> {
    if (input.source !== 'codex') {
      throw new Error('Codex native resume 只能用于 Codex session')
    }

    // Native resume 写回 Codex 原生 session;这里的事件仅用于 Cockpit SSE 即时展示。
    // 完成后前端会重新读取 ~/.codex/sessions 中的 JSONL 作为唯一事实来源。
    const codex = await resolveCodexCommand()
    if (!codex) throw new Error('codex CLI 不可用(本机未安装/登录对应 CLI)')
    // Native resume 只有两档:read-only 预览 vs trusted 全放行。
    // 没有 auto-safe / ask 中间档 —— CLI headless 接不住 approval,详见 docs/10。
    const trusted = input.writeMode === 'trusted'
    const globalArgs = trusted
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : ['--sandbox', 'read-only']
    // Native resume 也要能吐 reasoning:effort + summary 两个开关都要打开,不能只靠
    // 用户 ~/.codex/config.toml 的默认值,否则 timeline 大概率看不到 thinking 节点。
    const effort = input.effort ?? 'medium'
    const args = [
      ...globalArgs,
      '--cd',
      input.cwd ?? process.cwd(),
      'exec',
      'resume',
      '--json',
      '--skip-git-repo-check',
      '-c', `model_reasoning_effort="${effort}"`,
      '-c', 'model_reasoning_summary="auto"',
      input.sessionId,
      '-',
    ]

    const child = spawn(codex, args, {
      cwd: input.cwd ?? process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: input.signal,
    })
    child.stdin.write(input.text)
    child.stdin.end()

    let stderr = ''
    child.stderr.on('data', (d) => (stderr += String(d)))

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
    let turnError: string | null = null
    const toolUseEmitted = new Set<string>()

    for await (const line of rl) {
      if (!line.trim()) continue
      let o: Record<string, any>
      try {
        o = JSON.parse(line)
      } catch {
        continue
      }
      const ts = new Date().toISOString()
      switch (o.type) {
        case 'item.started':
          if (o.item && TOOL_ITEM_TYPES.has(o.item.type)) {
            const id = String(o.item.id ?? `codex_${Date.now()}`)
            const ev = toolUseFromItem(o.item, ts)
            if (ev) {
              toolUseEmitted.add(id)
              yield ev
            }
          }
          break
        case 'item.completed':
          if (o.item) {
            if (TOOL_ITEM_TYPES.has(o.item.type)) {
              const id = String(o.item.id ?? `codex_${Date.now()}`)
              if (!toolUseEmitted.has(id)) {
                const use = toolUseFromItem(o.item, ts)
                if (use) yield use
              }
              const result = toolResultFromItem(o.item, ts)
              if (result) yield result
            } else {
              for (const ev of translateCompletedNonTool(o.item, ts)) yield ev
            }
          }
          break
        case 'turn.completed':
          if (o.usage) {
            yield {
              type: 'usage',
              inputTokens: Number(o.usage.input_tokens ?? 0),
              outputTokens: Number(o.usage.output_tokens ?? 0),
              ts: new Date().toISOString(),
              agent: 'codex',
            }
          }
          break
        case 'turn.failed':
          turnError = String(o.error?.message ?? 'codex turn failed')
          break
        case 'error':
          turnError = String(o.message ?? 'codex error')
          break
      }
    }

    const code: number = await new Promise((resolve) => {
      if (child.exitCode != null) return resolve(child.exitCode)
      child.on('close', (c) => resolve(c ?? 0))
    })

    if (input.signal.aborted) throw new Error('aborted')
    if (turnError) throw new Error(turnError)
    if (code !== 0) throw new Error(stderr.trim() || `codex exited ${code}`)
  },
}
