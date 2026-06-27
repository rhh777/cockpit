import type { AgentName, EventEnvelope, NormalizedEvent } from '../loaders/types'
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

function agentSpeaker(agent?: AgentName): string {
  if (agent === 'claude') return '[Claude said]'
  if (agent === 'codex') return '[Codex said]'
  return '[Assistant said]'
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
        return `- ${label}: ${a.name} -> ${a.path}`
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
    default:
      return null
  }
}

export function serializeForAgent(
  contextEvents: EventEnvelope[],
  currentText: string,
  targetAgent: AgentName,
  options: Partial<SerializeOptions> = {},
): string {
  const opts = { ...DEFAULT_SERIALIZE, ...options }

  const bIdx = contextEvents.findIndex((e) => e.event.type === 'followup_boundary')
  const native = bIdx === -1 ? contextEvents : contextEvents.slice(0, bIdx)
  let followup = bIdx === -1 ? [] : contextEvents.slice(bIdx + 1)
  // 去掉末尾"当前请求"那条 user_text,避免在 history 和 Current Request 重复(docs/01 §九)。
  for (let i = followup.length - 1; i >= 0; i--) {
    const ev = followup[i].event
    if (ev.type === 'user_text') {
      if (ev.text.trim() === currentText.trim()) followup = followup.slice(0, i)
      break
    }
  }

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
