import { randomUUID } from 'node:crypto'
import type { AgentName, ChatAttachment, EventEnvelope, NormalizedEvent } from '../loaders/types'
import { renderAttachmentLines } from '../util/attachments'
import { agentDisplayName } from './agent-meta'
import { redactSecrets } from './sensitive'

// serializeForAgent 是 Phase 2 的核心边界(不变量 7)。Adapter 不能绕过它直接读原始 events。
// 策略与截断规则见 docs/01 §九。

export interface SerializeOptions {
  strategy: 'raw' | 'compact' | 'summary'
  maxChars: number
  maxToolInputChars: number
  maxToolOutputChars: number
  includeThinking: boolean
}

export const DEFAULT_SERIALIZE: SerializeOptions = {
  strategy: 'raw',
  maxChars: 24000,
  maxToolInputChars: 500,
  maxToolOutputChars: 1000,
  includeThinking: false,
}

function clip(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n) + `…[truncated ${s.length - n} chars]…`
}

// 显示名经 agent-meta(registry 注册时写入)取,不在这里维护第二份映射(docs/12 D1)。
function agentSpeaker(agent?: AgentName): string {
  return `[${agentDisplayName(agent)} said]`
}

function toolInputStr(input: unknown, max: number): string {
  // 输入路径敏感时不外发其内容,只留工具名层面的提示由调用方处理。
  let s: string
  try {
    s = typeof input === 'string' ? input : JSON.stringify(input)
  } catch {
    s = String(input)
  }
  return clip(redactSecrets(s).text, max)
}

function attachmentLines(attachments: Extract<NormalizedEvent, { type: 'user_text' }>['attachments']): string {
  if (!attachments?.length) return ''
  return (
    '\n[Attachments]\n' +
    attachments
      .map((a) => {
        const label = a.kind === 'directory' ? 'directory' : a.kind === 'image' ? `image ${a.mimeType}` : 'file'
        const target = a.kind === 'image' ? a.path ?? '[embedded image]' : a.path
        return `- ${label}: ${a.name} -> ${target}`
      })
      .join('\n')
  )
}

interface Sections {
  userGoal: string // 钉住
  finalResponse: string // 钉住
  timeline: string // 可砍(中段)
  toolActivity: string // 可砍(中段)
  followupHistory: string // 可砍(中段)
}

function renderEvent(env: EventEnvelope, opts: SerializeOptions): string | null {
  const e = env.event
  switch (e.type) {
    case 'user_text':
      return `${env.origin === 'cockpit' ? '[User follow-up]' : '[User said]'}: ${e.text}${attachmentLines(e.attachments)}`
    case 'assistant_text':
      return `${agentSpeaker(e.agent)}: ${e.text}`
    case 'thinking':
      return opts.includeThinking ? `[thinking]: ${e.text}` : null
    case 'tool_use':
      return `[tool ${e.name}] input: ${toolInputStr(e.input, opts.maxToolInputChars)}`
    case 'tool_result': {
      // 错误 > diff/patch > 测试失败 > 文件片段 > 普通输出(docs/01 §九)。
      const prefix = e.isError ? '[tool error]' : '[tool result]'
      return `${prefix}: ${clip(redactSecrets(e.output).text, opts.maxToolOutputChars)}`
    }
    case 'meta': {
      // Phase 4 增量:context-projector 用 meta.context_summary 承载已被 summary 覆盖的历史。
      if (e.key === 'context_summary') {
        const v = e.value as { summary?: string } | undefined
        const summary = typeof v?.summary === 'string' ? v.summary : ''
        return summary ? `[Session summary of earlier history]\n${summary}` : null
      }
      return null
    }
    default:
      return null
  }
}

// —— 群聊模式(docs/12 E1)——————————————————————————————————————————
// 群聊没有「Original Session」:上下文是共享 summary + 近期 transcript。
// 这里(序列化边界内)构建群聊上下文,产出一条 meta:group_context 事件;
// serializeForAgent 识别后走群聊专属模板,不再套 User Goal/Final Response 壳,
// 当前请求也只出现在 Current Request 一处。

export const GROUP_CONTEXT_META_KEY = 'group_context'

const GROUP_MESSAGE_HEAD_CHARS = 800
const GROUP_MESSAGE_TAIL_CHARS = 400
const GROUP_MESSAGE_MAX_CHARS = GROUP_MESSAGE_HEAD_CHARS + GROUP_MESSAGE_TAIL_CHARS + 200

function clipGroupMessage(text: string): string {
  if (text.length <= GROUP_MESSAGE_MAX_CHARS) return text
  const head = text.slice(0, GROUP_MESSAGE_HEAD_CHARS)
  const tail = text.slice(text.length - GROUP_MESSAGE_TAIL_CHARS)
  const omitted = text.length - GROUP_MESSAGE_HEAD_CHARS - GROUP_MESSAGE_TAIL_CHARS
  return `${head}\n...[omitted ${omitted} chars]...\n${tail}`
}

export function buildGroupContextEvents(
  transcript: EventEnvelope[],
  summary: string,
  targetAgent: AgentName,
  currentAttachments: ChatAttachment[] = [],
): EventEnvelope[] {
  const recent = transcript
    .filter((env) => env.event.type !== 'meta' && env.event.type !== 'usage')
    .slice(-30)
    .map((env) => {
      const e = env.event
      if (e.type === 'user_text')
        return [`[User]: ${clipGroupMessage(e.text || '(no text)')}`, ...renderAttachmentLines(e.attachments)].join('\n')
      if (e.type === 'assistant_text') return `[${agentDisplayName(e.agent)}]: ${clipGroupMessage(e.text)}`
      if (e.type === 'tool_use') return `[${agentDisplayName(e.agent)} tool]: ${e.name}`
      if (e.type === 'tool_result') return `[Tool result]: ${e.isError ? 'error' : 'ok'}`
      if (e.type === 'thinking') return `[${agentDisplayName(targetAgent)} thinking]: ${clipGroupMessage(e.text)}`
      return null
    })
    .filter((x): x is string => x != null)
    .join('\n')

  const text = [
    '# Cockpit Group Chat',
    '',
    `You are ${agentDisplayName(targetAgent)} participating in a local Cockpit group chat.`,
    'Only answer the current request. The transcript below is the Cockpit source of truth.',
    '',
    '## Shared Summary',
    summary.trim() || '(empty)',
    '',
    '## Recent Transcript',
    recent || '(empty)',
    ...(currentAttachments.length ? ['', '## Current Request Attachments', ...renderAttachmentLines(currentAttachments)] : []),
  ].join('\n')

  return [
    {
      origin: 'cockpit',
      source: 'cockpit',
      sourceEventId: `ctx_${randomUUID()}`,
      event: { type: 'meta', key: GROUP_CONTEXT_META_KEY, value: { text }, ts: new Date().toISOString() },
    },
  ]
}

function serializeGroupPrompt(
  groupText: string,
  currentText: string,
  targetAgent: AgentName,
  opts: SerializeOptions,
): string {
  const pinnedTail = [
    '',
    '# Current Request',
    `请以 ${agentDisplayName(targetAgent)} 的身份回应下面这条请求(上面是群聊上下文,不要自代入其它成员的发言):`,
    currentText,
  ].join('\n')
  const budget = Math.max(0, opts.maxChars - pinnedTail.length)
  let body = groupText
  if (body.length > budget) {
    const keep = Math.max(0, budget - 40)
    const head = body.slice(0, Math.floor(keep / 2))
    const tail = body.slice(body.length - Math.ceil(keep / 2))
    body = `${head}\n…[truncated ${body.length - keep} chars of group context]…\n${tail}`
  }
  return redactSecrets(body + pinnedTail).text
}

export function serializeForAgent(
  contextEvents: EventEnvelope[],
  currentText: string,
  targetAgent: AgentName,
  options: Partial<SerializeOptions> = {},
): string {
  const opts = { ...DEFAULT_SERIALIZE, ...options }

  // 群聊模式:上下文由 buildGroupContextEvents 构建,走群聊专属模板。
  const groupCtx = contextEvents.find(
    (e) => e.event.type === 'meta' && e.event.key === GROUP_CONTEXT_META_KEY,
  )
  if (groupCtx && groupCtx.event.type === 'meta') {
    const v = groupCtx.event.value as { text?: string } | undefined
    return serializeGroupPrompt(typeof v?.text === 'string' ? v.text : '', currentText, targetAgent, opts)
  }

  const bIdx = contextEvents.findIndex((e) => e.event.type === 'followup_boundary')
  const native = bIdx === -1 ? contextEvents : contextEvents.slice(0, bIdx)
  // 契约:contextEvents 不含当前请求 —— 调用方(run-registry)按 turnId 剔除当前轮,
  // 保证当前请求只出现在 Current Request(docs/01 §九)。这里不再做文本相等的去重兜底:
  // 文本匹配在带附件(withAttachments 拼接)或用户重复发同一句时都会误判。
  const followup = bIdx === -1 ? [] : contextEvents.slice(bIdx + 1)

  const userTexts = native.filter((e) => e.event.type === 'user_text')
  const assistantTexts = native.filter((e) => e.event.type === 'assistant_text')
  const firstUser = userTexts[0]?.event as Extract<NormalizedEvent, { type: 'user_text' }> | undefined
  const lastAssistant = assistantTexts[assistantTexts.length - 1]?.event as
    | Extract<NormalizedEvent, { type: 'assistant_text' }>
    | undefined

  const sections: Sections = {
    userGoal: firstUser ? firstUser.text : '(无明确初始目标)',
    finalResponse: lastAssistant ? lastAssistant.text : '(原始 session 无最终回复)',
    timeline: native
      .map((e) => renderEvent(e, opts))
      .filter((x): x is string => x != null)
      .join('\n'),
    toolActivity: (() => {
      const tools = native.filter((e) => e.event.type === 'tool_use')
      const errs = native.filter((e) => e.event.type === 'tool_result' && (e.event as any).isError)
      return `工具调用 ${tools.length} 次,失败 ${errs.length} 次`
    })(),
    followupHistory: followup
      .map((e) => renderEvent(e, opts))
      .filter((x): x is string => x != null)
      .join('\n'),
  }

  // 钉住部分永不截断。
  const pinnedHead = [
    '# Original Session',
    '',
    '## User Goal',
    sections.userGoal,
    '',
  ].join('\n')
  const pinnedFinal = ['', '## Final Response', sections.finalResponse].join('\n')
  const pinnedTail = [
    '',
    '# Current Request',
    `请以 ${targetAgent} 的身份回应下面这条请求(上面是上下文,不要自代入历史里其它 agent 的发言):`,
    currentText,
  ].join('\n')

  // 中段(可砍):Timeline + Tool Activity + Follow-up History。
  const middle = [
    '## Timeline',
    sections.timeline || '(空)',
    '',
    '## Tool Activity',
    sections.toolActivity,
    sections.followupHistory ? '\n# Cockpit Follow-up History\n' + sections.followupHistory : '',
  ].join('\n')

  const fixedLen = pinnedHead.length + pinnedFinal.length + pinnedTail.length
  const budget = Math.max(0, opts.maxChars - fixedLen)

  let middleOut = middle
  if (middle.length > budget) {
    // 从中间往两头砍:保留 middle 的头尾,中间插占位。
    const keep = Math.max(0, budget - 40)
    const head = middle.slice(0, Math.floor(keep / 2))
    const tail = middle.slice(middle.length - Math.ceil(keep / 2))
    middleOut = `${head}\n…[truncated ${middle.length - keep} chars of middle history]…\n${tail}`
  }

  const prompt = [pinnedHead, middleOut, pinnedFinal, pinnedTail].join('\n')
  // 最终再跑一遍密钥屏蔽(纵深防御)。
  return redactSecrets(prompt).text
}
