// cockpit 按 docs/01 §七用本机 CLI 子进程调用,不装官方 SDK。
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import type { NormalizedEvent } from '../loaders/types'
import { normalizeClaudeLine } from '../loaders/claude-loader'
import { serializeForAgent } from './serialize'
import type { AgentRunInput, NativeResumeInput, ReviewAgent } from './types'
import { commandExists } from './cli-utils'

// 只读工具集(docs/01 §九/§十):只允许 Read/Grep/Glob,write/exec 默认禁。
const READONLY_TOOLS = ['Read', 'Grep', 'Glob']
const CLAUDE_TRANSIENT_RETRY_ATTEMPTS = 2

function isRetryableClaudeError(message: string): boolean {
  const m = message.toLowerCase()
  return (
    m.includes('econnreset') ||
    m.includes('unable to connect to api') ||
    m.includes('connection reset') ||
    m.includes('connection closed') ||
    m.includes('network') ||
    m.includes('timeout') ||
    m.includes('tls handshake eof')
  )
}

function explainClaudeError(message: string): string {
  if (isRetryableClaudeError(message)) {
    return [
      'Claude Code CLI 连接 API 失败。Claude Desktop 正常不代表 Claude Code CLI 的登录态/代理/网络环境也正常。',
      '通常需要检查终端里的 Claude Code CLI 是否能连通,以及代理/VPN/DNS/公司网关是否对 CLI 生效。',
      `原始错误: ${message}`,
      '请确认终端里 `claude -p "hello"` 可以正常返回后再试。',
    ].join(' ')
  }
  return message
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

async function* runClaudePrint(
  prompt: string,
  extraArgs: string[],
  input: Pick<AgentRunInput | NativeResumeInput, 'cwd' | 'signal'>,
  useTools: boolean,
  model?: string,
  effort?: string,
): AsyncGenerator<NormalizedEvent> {
  const args = [
    '-p',
    ...extraArgs,
    ...(model ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : []),
    '--output-format',
    'stream-json',
    '--verbose',
    // 逐 token 流式:claude CLI 暴露 content_block_delta text_delta;否则只在 turn 末一次性吐
    // 整段 assistant_text,UI 看上去是"一坨蹦出来"。
    '--include-partial-messages',
    '--permission-mode',
    'default',
    ...(useTools
      ? ['--allowedTools', ...READONLY_TOOLS]
      : ['--disallowedTools', 'Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch']),
  ]

  const child = spawn('claude', args, {
    cwd: input.cwd ?? process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: input.signal,
  })
  // prompt 经 stdin 传(避免超长 arg)。
  child.stdin.write(prompt)
  child.stdin.end()

  let stderr = ''
  child.stderr.on('data', (d) => (stderr += String(d)))

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  let sawResult = false
  let resultError: string | null = null
  // 跟踪当前流式 message_id;text_delta 用它和 block index 拼成 streamId,UI 端合并。
  let currentMsgId = ''
  // 哪些 message_id 已经在 stream_event 里逐 token 吐过 text。等同 msgId 的终态 `assistant`
  // 事件到达时,跳过其中的 text 块(避免和 delta 重复),其余块(tool_use/thinking/usage)照常。
  const streamedTextMsgIds = new Set<string>()

  for await (const line of rl) {
    if (!line.trim()) continue
    let o: Record<string, unknown>
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const type = o.type as string

    if (type === 'stream_event') {
      const se = o.event as Record<string, unknown> | undefined
      const seType = se?.type as string | undefined
      if (seType === 'message_start') {
        const msg = se?.message as Record<string, unknown> | undefined
        currentMsgId = String(msg?.id ?? '')
      } else if (seType === 'content_block_delta') {
        const delta = se?.delta as Record<string, unknown> | undefined
        if (delta?.type === 'text_delta' && typeof delta.text === 'string' && currentMsgId) {
          const idx = Number(se?.index ?? 0)
          streamedTextMsgIds.add(currentMsgId)
          yield {
            type: 'assistant_text',
            text: delta.text as string,
            ts: new Date().toISOString(),
            agent: 'claude',
            streamId: `${currentMsgId}:${idx}`,
            delta: true,
          }
        }
      }
      // message_start 之外的 stream_event(content_block_start/stop、message_delta/stop)忽略。
    } else if (type === 'assistant') {
      const msg = o.message as Record<string, unknown> | undefined
      const msgId = String(msg?.id ?? '')
      const hadStreamedText = msgId && streamedTextMsgIds.has(msgId)
      if (hadStreamedText) {
        for (const ev of normalizeClaudeFinalMessage(o, msgId)) yield ev
      } else {
        for (const ev of normalizeClaudeLine(o)) yield ev
      }
    } else if (type === 'user') {
      for (const ev of normalizeClaudeLine(o)) yield ev
    } else if (type === 'result') {
      sawResult = true
      if (o.is_error) resultError = String(o.result ?? o.subtype ?? 'claude error')
      // result.result 文本已由前面的 assistant 行产出,这里不重复;仅记终态。
    } else if (type === 'system' && o.subtype === 'api_retry') {
      const attempt = Number(o.attempt ?? 0)
      const max = Number(o.max_retries ?? 0)
      const delayMs = Number(o.retry_delay_ms ?? 0)
      const wait = delayMs > 0 ? `, ${Math.round(delayMs / 1000)}s 后重试` : ''
      yield {
        type: 'thinking',
        text: `Claude Code CLI 正在重试连接 API${attempt && max ? ` ${attempt}/${max}` : ''}${wait}`,
        ts: new Date().toISOString(),
      }
    }
    // system / rate_limit_event 等忽略。
  }

  const code: number = await new Promise((resolve) => {
    if (child.exitCode != null) return resolve(child.exitCode)
    child.on('close', (c) => resolve(c ?? 0))
  })

  if (input.signal.aborted) throw new Error('aborted')
  if (resultError) throw new Error(explainClaudeError(resultError))
  if (!sawResult && code !== 0) {
    throw new Error(explainClaudeError(stderr.trim() || `claude exited ${code}`))
  }
}

function normalizeClaudeFinalMessage(
  o: Record<string, unknown>,
  msgId: string,
): NormalizedEvent[] {
  const ts = (o.timestamp as string) ?? new Date().toISOString()
  const message = o.message as Record<string, unknown> | undefined
  const content = message?.content
  if (!Array.isArray(content)) return normalizeClaudeLine(o)

  const out: NormalizedEvent[] = []
  for (const [idx, p] of (content as Record<string, unknown>[]).entries()) {
    if (p?.type === 'text' && typeof p.text === 'string') {
      out.push({
        type: 'assistant_text',
        text: p.text,
        ts,
        agent: 'claude',
        streamId: `${msgId}:${idx}`,
      })
    } else if (p?.type === 'thinking' && typeof p.thinking === 'string') {
      out.push({ type: 'thinking', text: p.thinking, ts })
    } else if (p?.type === 'tool_use') {
      out.push({
        type: 'tool_use',
        id: String(p.id ?? ''),
        name: String(p.name ?? 'unknown'),
        input: p.input,
        ts,
        agent: 'claude',
      })
    }
  }

  const usage = message?.usage as Record<string, unknown> | undefined
  if (usage && (usage.input_tokens != null || usage.output_tokens != null)) {
    out.push({
      type: 'usage',
      inputTokens: Number(usage.input_tokens ?? 0),
      outputTokens: Number(usage.output_tokens ?? 0),
      ts,
      agent: 'claude',
    })
  }
  return out
}

export const claudeAdapter: ReviewAgent = {
  name: 'claude',

  async isAvailable() {
    return commandExists('claude', ['--version'])
  },

  async *run(input: AgentRunInput): AsyncGenerator<NormalizedEvent> {
    const prompt = serializeForAgent(input.contextEvents, input.text, 'claude')
    yield* runClaudeWithRetry(
      () =>
        runClaudePrint(
          prompt,
          ['--no-session-persistence'],
          input,
          input.useTools,
          input.model,
          input.effort,
        ),
      input.signal,
    )
  },

  canResumeNative(source: string) {
    return source === 'claude-code'
  },

  async *resumeNative(input: NativeResumeInput): AsyncGenerator<NormalizedEvent> {
    if (input.source !== 'claude-code') {
      throw new Error('Claude native resume 只能用于 Claude Code session')
    }
    yield* runClaudeWithRetry(
      () => runClaudePrint(input.text, ['--resume', input.sessionId], input, true),
      input.signal,
    )
  },
}

async function* runClaudeWithRetry(
  makeRun: () => AsyncGenerator<NormalizedEvent>,
  signal: AbortSignal,
): AsyncGenerator<NormalizedEvent> {
  for (let attempt = 1; attempt <= CLAUDE_TRANSIENT_RETRY_ATTEMPTS; attempt++) {
    let emitted = 0
    try {
      for await (const ev of makeRun()) {
        emitted++
        yield ev
      }
      return
    } catch (err) {
      if (signal.aborted) throw err
      const message = String((err as Error)?.message ?? err)
      const canRetry =
        attempt < CLAUDE_TRANSIENT_RETRY_ATTEMPTS &&
        emitted === 0 &&
        isRetryableClaudeError(message)
      if (!canRetry) throw err
      yield {
        type: 'meta',
        key: 'claude_retry',
        value: {
          attempt: attempt + 1,
          maxAttempts: CLAUDE_TRANSIENT_RETRY_ATTEMPTS,
          reason: message,
        },
        ts: new Date().toISOString(),
      }
      await sleep(800 * attempt, signal)
    }
  }
}
