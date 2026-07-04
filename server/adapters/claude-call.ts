// Claude adapter:默认仍可走本机 CLI;需要逐工具审批时走 Claude Agent SDK + 本机 claude 登录态。
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import os from 'node:os'
import path from 'node:path'
import type { CanUseTool, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import type { NormalizedEvent } from '../loaders/types'
import { normalizeClaudeLine } from '../loaders/claude-loader'
import { serializeForAgent } from './serialize'
import type { AgentRunInput, NativeResumeInput, ReviewAgent } from './types'
import { commandExists } from './cli-utils'
import { claudePermissionArgs } from '../permissions/adapter-policy'
import type { Operation } from '../permissions/types'
import { stringifyToolResult } from '../util/jsonl'

const CLAUDE_TRANSIENT_RETRY_ATTEMPTS = 2

type ClaudeAgentSdkModule = typeof import('@anthropic-ai/claude-agent-sdk')

async function loadClaudeAgentSdk(): Promise<ClaudeAgentSdkModule> {
  // Keep the SDK out of Electron's CJS main-process bundle. The package uses
  // ESM metadata internally, so bundling it into main.cjs breaks import.meta.url.
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<ClaudeAgentSdkModule>
  return dynamicImport('@anthropic-ai/claude-agent-sdk')
}

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
  input: Pick<AgentRunInput | NativeResumeInput, 'cwd' | 'signal'> & { writableRoots?: string[] },
  useTools: boolean,
  model?: string,
  effort?: string,
  permissions?: AgentRunInput['permissions'],
): AsyncGenerator<NormalizedEvent> {
  const args = [
    '-p',
    ...extraArgs,
    ...(model ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : []),
    ...(input.writableRoots ?? []).flatMap((dir) => ['--add-dir', dir]),
    '--output-format',
    'stream-json',
    '--verbose',
    // 逐 token 流式:claude CLI 暴露 content_block_delta text_delta;否则只在 turn 末一次性吐
    // 整段 assistant_text,UI 看上去是"一坨蹦出来"。
    '--include-partial-messages',
    ...claudePermissionArgs(permissions, useTools),
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

function stringField(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function expandHome(p: string): string {
  if (p === '~' || p === '$HOME' || p === '${HOME}') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  if (p.startsWith('$HOME/')) return path.join(os.homedir(), p.slice('$HOME/'.length))
  if (p.startsWith('${HOME}/')) return path.join(os.homedir(), p.slice('${HOME}/'.length))
  return p
}

function directoryForCandidate(candidate: string): string | null {
  if (!candidate || candidate.startsWith('(')) return null
  const expanded = expandHome(candidate)
  const ext = path.extname(expanded)
  return ext ? path.dirname(expanded) : expanded
}

function shellPathCandidates(command: string): string[] {
  const candidates = new Set<string>()
  const re = /(?:^|[\s"'=<>])((?:~|\$HOME|\$\{HOME\}|\/)[^\s"'`;&|<>)]*)/g
  for (const match of command.matchAll(re)) {
    const raw = match[1]?.replace(/[.,:]+$/, '')
    if (raw) candidates.add(raw)
  }
  return [...candidates]
}

function directoriesForPermission(operation: Operation, blockedPath?: string): string[] {
  const candidates = new Set<string>()
  const primary =
    blockedPath ??
    (operation.kind === 'file_write' || operation.kind === 'file_read'
      ? operation.path
      : operation.kind === 'shell'
        ? operation.cwd ?? undefined
        : undefined)
  if (primary) candidates.add(primary)
  if (operation.kind === 'shell') {
    for (const candidate of shellPathCandidates(operation.command)) candidates.add(candidate)
  }
  return [...candidates].map(directoryForCandidate).filter((dir): dir is string => !!dir)
}

export function permissionUpdatesForApproval(
  toolName: string,
  operation: Operation,
  blockedPath?: string,
  suggestions?: PermissionUpdate[],
): PermissionUpdate[] | undefined {
  const updates: PermissionUpdate[] = [...(suggestions ?? [])]
  const hasAllowRule = updates.some(
    (update) =>
      update.type === 'addRules' &&
      update.behavior === 'allow' &&
      update.rules.some((rule) => rule.toolName === toolName),
  )
  if (!hasAllowRule) {
    updates.push({
      type: 'addRules',
      behavior: 'allow',
      destination: 'session',
      rules: [{ toolName }],
    })
  }

  const existingDirs = new Set<string>()
  for (const update of updates) {
    if (update.type === 'addDirectories') {
      for (const dir of update.directories) existingDirs.add(expandHome(dir))
    }
  }

  const missingDirs = directoriesForPermission(operation, blockedPath).filter((dir) => {
    const expanded = expandHome(dir)
    if (existingDirs.has(expanded)) return false
    existingDirs.add(expanded)
    return true
  })
  if (missingDirs.length) {
    updates.push({
      type: 'addDirectories',
      destination: 'session',
      directories: missingDirs,
    })
  }
  return updates
}

export function claudeToolOperation(toolName: string, input: Record<string, unknown>): Operation | null {
  switch (toolName) {
    case 'Read':
      return { kind: 'file_read', path: stringField(input, ['file_path', 'path']) ?? '(unknown file)' }
    case 'Grep':
    case 'Glob':
      return { kind: 'file_read', path: stringField(input, ['path', 'cwd']) ?? '(workspace search)' }
    case 'Write':
      return { kind: 'file_write', path: stringField(input, ['file_path', 'path']) ?? '(unknown file)', action: 'create' }
    case 'Edit':
    case 'MultiEdit':
      return { kind: 'file_write', path: stringField(input, ['file_path', 'path']) ?? '(unknown file)', action: 'edit' }
    case 'Bash':
      return { kind: 'shell', command: stringField(input, ['command']) ?? '(unknown command)', cwd: stringField(input, ['cwd']) ?? null }
    case 'WebFetch':
      return { kind: 'network', url: stringField(input, ['url']) ?? undefined }
    case 'WebSearch':
      return { kind: 'network', host: 'web search' }
    default:
      return null
  }
}

function isAutoAllowedClaudeRead(operation: Operation): boolean {
  return operation.kind === 'file_read'
}

export function claudeAllowPermissionResult(
  toolName: string,
  toolInput: Record<string, unknown>,
  operation: Operation,
  options: { toolUseID?: string; blockedPath?: string; suggestions?: PermissionUpdate[] },
) {
  return {
    behavior: 'allow' as const,
    // The SDK runtime schema currently requires this on allow results even
    // though the published d.ts marks it optional.
    updatedInput: toolInput,
    toolUseID: options.toolUseID,
    decisionClassification: 'user_temporary' as const,
    updatedPermissions: permissionUpdatesForApproval(toolName, operation, options.blockedPath, options.suggestions),
  }
}

function normalizeSdkMessage(message: SDKMessage, streamedTextMsgIds: Set<string>): NormalizedEvent[] {
  const o = message as any
  const type = o.type as string
  const ts = new Date().toISOString()
  if (type === 'stream_event') {
    const se = o.event as Record<string, any> | undefined
    if (se?.type === 'content_block_delta') {
      const delta = se.delta as Record<string, any> | undefined
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        const streamId = `${String(o.uuid ?? 'claude_sdk')}:${Number(se.index ?? 0)}`
        streamedTextMsgIds.add(streamId)
        return [{ type: 'assistant_text', text: delta.text, ts, agent: 'claude', streamId, delta: true }]
      }
    }
    return []
  }
  if (type === 'assistant') {
    const msgId = String(o.uuid ?? o.message?.id ?? `claude_sdk_${Date.now()}`)
    const content = o.message?.content
    if (!Array.isArray(content)) return []
    const out: NormalizedEvent[] = []
    for (const [idx, part] of (content as Record<string, any>[]).entries()) {
      const streamId = `${msgId}:${idx}`
      if (part.type === 'text' && typeof part.text === 'string') {
        if (!streamedTextMsgIds.has(streamId)) {
          out.push({ type: 'assistant_text', text: part.text, ts, agent: 'claude', streamId })
        }
      } else if (part.type === 'thinking' && typeof part.thinking === 'string') {
        out.push({ type: 'thinking', text: part.thinking, ts })
      } else if (part.type === 'tool_use') {
        out.push({
          type: 'tool_use',
          id: String(part.id ?? `${msgId}:${idx}`),
          name: String(part.name ?? 'unknown'),
          input: part.input,
          ts,
          agent: 'claude',
        })
      }
    }
    const usage = o.message?.usage
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
  if (type === 'user') {
    const message = o.message as Record<string, any> | undefined
    const content = message?.content
    const out: NormalizedEvent[] = []
    if (Array.isArray(content)) {
      for (const part of content as Record<string, any>[]) {
        if (part?.type === 'tool_result') {
          out.push({
            type: 'tool_result',
            toolUseId: String(part.tool_use_id ?? ''),
            output: stringifyToolResult(part.content),
            isError: !!part.is_error,
            ts: o.timestamp ?? ts,
          })
        }
      }
    }
    if (out.length) return out
    return []
  }
  if (type === 'result') {
    if (o.is_error) return [{ type: 'meta', key: 'claude_error', value: { message: o.result ?? o.subtype }, ts }]
    const usage = o.usage
    if (usage && (usage.input_tokens != null || usage.output_tokens != null)) {
      return [{
        type: 'usage',
        inputTokens: Number(usage.input_tokens ?? 0),
        outputTokens: Number(usage.output_tokens ?? 0),
        ts,
        agent: 'claude',
      }]
    }
  }
  if (type === 'api_retry') {
    return [{ type: 'thinking', text: 'Claude Agent SDK 正在重试连接 API', ts }]
  }
  if (type === 'system' && o.subtype === 'permission_denied') {
    return [{ type: 'meta', key: 'claude_permission_denied', value: o, ts }]
  }
  return []
}

async function* runClaudeSdk(input: AgentRunInput): AsyncGenerator<NormalizedEvent> {
  if (!input.requestApproval) throw new Error('Claude SDK approval requires requestApproval callback')
  const { query } = await loadClaudeAgentSdk()
  const prompt = serializeForAgent(input.contextEvents, input.text, 'claude')
  const canUseTool: CanUseTool = async (toolName, toolInput, options) => {
    const operation = claudeToolOperation(toolName, toolInput)
    if (!operation) {
      const status = await input.requestApproval!(
        { kind: 'shell', command: `${toolName} ${JSON.stringify(toolInput)}`, cwd: input.cwd },
        options.title ?? options.decisionReason,
      )
      return status === 'approved'
        ? claudeAllowPermissionResult(
            toolName,
            toolInput,
            { kind: 'shell', command: `${toolName} ${JSON.stringify(toolInput)}`, cwd: input.cwd },
            options,
          )
        : { behavior: 'deny', message: 'Rejected by user', toolUseID: options.toolUseID, decisionClassification: 'user_reject' }
    }
    if (isAutoAllowedClaudeRead(operation)) {
      return claudeAllowPermissionResult(toolName, toolInput, operation, options)
    }
    const status = await input.requestApproval!(
      operation,
      options.title ?? options.description ?? options.decisionReason,
    )
    return status === 'approved'
      ? claudeAllowPermissionResult(toolName, toolInput, operation, options)
      : { behavior: 'deny', message: 'Rejected by user', toolUseID: options.toolUseID, decisionClassification: 'user_reject' }
  }

  const q = query({
    prompt,
    options: {
      cwd: input.cwd ?? process.cwd(),
      pathToClaudeCodeExecutable: 'claude',
      ...(input.model ? { model: input.model } : {}),
      ...(input.writableRoots?.length ? { additionalDirectories: input.writableRoots.map(expandHome) } : {}),
      permissionMode: 'default',
      tools: { type: 'preset', preset: 'claude_code' },
      canUseTool,
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'cockpit/0.1.0' },
    },
  })
  const onAbort = () => q.close()
  input.signal.addEventListener('abort', onAbort, { once: true })
  const streamedTextMsgIds = new Set<string>()
  try {
    for await (const message of q) {
      if (input.signal.aborted) throw new Error('aborted')
      for (const ev of normalizeSdkMessage(message, streamedTextMsgIds)) yield ev
      const raw = message as any
      if (raw.type === 'result' && raw.is_error) {
        throw new Error(explainClaudeError(String(raw.result ?? raw.subtype ?? 'claude sdk error')))
      }
      if (raw.type === 'assistant' && raw.error) {
        throw new Error(explainClaudeError(String(raw.error)))
      }
    }
  } finally {
    input.signal.removeEventListener('abort', onAbort)
    q.close()
  }
}

export const claudeAdapter: ReviewAgent = {
  name: 'claude',

  async isAvailable() {
    return commandExists('claude', ['--version'])
  },

  async *run(input: AgentRunInput): AsyncGenerator<NormalizedEvent> {
    if (input.requestApproval) {
      yield* runClaudeSdk(input)
      return
    }
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
          input.permissions,
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
