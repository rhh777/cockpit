// cockpit 按 docs/01 §七用本机 `codex exec` 子进程调用,不装 @openai/codex-sdk。
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import type { NormalizedEvent } from '../loaders/types'
import { serializeForAgent } from './serialize'
import type { AgentRunInput, NativeResumeInput, ReviewAgent } from './types'
import { commandExists } from './cli-utils'

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

const CODEX_TRANSIENT_RETRY_ATTEMPTS = 2
const CODEX_COMMAND_CANDIDATES = [
  process.env.CODEX_BIN,
  process.env.HOME ? `${process.env.HOME}/.codex/plugins/.plugin-appserver/codex` : undefined,
  '/Applications/work/Codex.app/Contents/Resources/codex',
  'codex',
].filter((v): v is string => !!v)

let resolvedCodexCommand: Promise<string | null> | null = null

async function resolveCodexCommand(): Promise<string | null> {
  resolvedCodexCommand ??= (async () => {
    for (const candidate of CODEX_COMMAND_CANDIDATES) {
      if (await commandExists(candidate, ['--version'])) return candidate
    }
    return null
  })()
  return resolvedCodexCommand
}

function isRetryableCodexError(message: string): boolean {
  const m = message.toLowerCase()
  return (
    m.includes('tls handshake eof') ||
    m.includes('stream disconnected before completion') ||
    m.includes('reconnecting') ||
    m.includes('connection reset') ||
    m.includes('connection closed') ||
    m.includes('network') ||
    m.includes('timeout')
  )
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('aborted'))
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new Error('aborted'))
      },
      { once: true },
    )
  })
}

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

async function* runCodexExec(input: AgentRunInput): AsyncGenerator<NormalizedEvent> {
  const prompt = serializeForAgent(input.contextEvents, input.text, 'codex')
  const codex = await resolveCodexCommand()
  if (!codex) throw new Error('codex CLI 不可用(本机未安装/登录对应 CLI)')

  // 只读 + 禁审批沙箱 + 禁 git 检查(docs/01 §九 / T13)。prompt 作为位置参数。
  // Cockpit follow-up / group-chat worker 不应污染原生 Codex session 列表。
  const args = [
    'exec',
    '--json',
    '--ephemeral',
    '--sandbox',
    'read-only', // MVP 始终只读沙箱,不随 useTools 放开
    '--skip-git-repo-check',
    ...(input.model ? ['--model', input.model] : []),
    // `-c key=value`,value 走 TOML 解析:用带引号字符串避免 "high" / "low" 被当作裸 token。
    ...(input.effort ? ['-c', `model_reasoning_effort="${input.effort}"`] : []),
    '-C',
    input.cwd ?? process.cwd(),
    prompt,
  ]

  const child = spawn(codex, args, {
    cwd: input.cwd ?? process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    signal: input.signal,
  })

  let stderr = ''
  child.stderr.on('data', (d) => (stderr += String(d)))

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  let turnError: string | null = null
  // 已经 emit 过 tool_use 的 item id —— 防止 started+completed 双发。
  const toolUseEmitted = new Set<string>()

  for await (const line of rl) {
    if (!line.trim()) continue
    let o: Record<string, any>
    try {
      o = JSON.parse(line)
    } catch {
      continue // 非 JSON 提示行(如 "Reading additional input from stdin...")
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
            // started 没追到时兜底:补一条 tool_use,免得结果孤儿。
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
      // thread.started / turn.started / item.started / item.updated 忽略
    }
  }

  const code: number = await new Promise((resolve) => {
    if (child.exitCode != null) return resolve(child.exitCode)
    child.on('close', (c) => resolve(c ?? 0))
  })

  if (input.signal.aborted) throw new Error('aborted')
  if (turnError) throw new Error(turnError)
  if (code !== 0) throw new Error(stderr.trim() || `codex exited ${code}`)
}

export const codexAdapter: ReviewAgent = {
  name: 'codex',

  async isAvailable() {
    // 注意:codex 的 vendored 二进制可能缺失 → spawn ENOENT,这里能检出。
    return (await resolveCodexCommand()) !== null
  },

  async *run(input: AgentRunInput): AsyncGenerator<NormalizedEvent> {
    for (let attempt = 1; attempt <= CODEX_TRANSIENT_RETRY_ATTEMPTS; attempt++) {
      let emitted = 0
      try {
        for await (const ev of runCodexExec(input)) {
          emitted++
          yield ev
        }
        return
      } catch (err) {
        if (input.signal.aborted) throw err
        const message = String((err as Error)?.message ?? err)
        const canRetry =
          attempt < CODEX_TRANSIENT_RETRY_ATTEMPTS &&
          emitted === 0 &&
          isRetryableCodexError(message)
        if (!canRetry) throw err
        yield {
          type: 'meta',
          key: 'codex_retry',
          value: {
            attempt: attempt + 1,
            maxAttempts: CODEX_TRANSIENT_RETRY_ATTEMPTS,
            reason: message,
          },
          ts: new Date().toISOString(),
        }
        await sleep(800 * attempt, input.signal)
      }
    }
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
    const args = [
      '--sandbox',
      'read-only',
      '--cd',
      input.cwd ?? process.cwd(),
      'exec',
      'resume',
      '--json',
      '--skip-git-repo-check',
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
