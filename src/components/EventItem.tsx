import { useState } from 'react'
import type { EventEnvelope } from '../lib/types'
import type { ToolPair } from '../lib/timeline'
import { agentAvatarClass } from '../lib/display'
import { Markdown } from './Markdown'
import { ToolCallCard } from './ToolCallCard'
import { Icon } from './Icon'
import { AgentIcon, agentLabel } from './AgentIcon'

// 噪音 meta 键:这类事件对用户阅读 timeline 毫无价值,默认不渲染。
// turn_status 走单独分支(成功/失败/中断状态条),仍保留。
const META_HIDDEN_KEYS = new Set([
  // Claude:JSONL 顶层 type 兜底成的 meta
  'mode',
  'permission-mode',
  'file-history-snapshot',
  'summary',
  'system',
  // Codex:rollout 里非核心事件
  'task_started',
  'task_complete',
  'turn_aborted',
  'turn_start',
  'unknown',
  // Claude:attachment 是注入给模型的上下文增量(mcp_instructions_delta、todo_reminder、
  // hook_additional_context、file/directory 快照等),不是用户/模型可见内容。
  // 见 docs/03-roadmap.md:"❌ 不做 attachment 渲染"。
  'attachment',
])

// Claude 在 slash 命令 / 本地命令 / pre-amble 注释里塞了不少 XML 包装,parseUserText 把它们识别出来。
function extractTag(text: string, tag: string): string | null {
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return m ? m[1] : null
}
function stripWrappers(text: string, tags: string[]): string {
  let out = text
  for (const t of tags) {
    out = out.replace(new RegExp(`<${t}>[\\s\\S]*?<\\/${t}>`, 'gi'), '')
  }
  return out.trim()
}

type UserTextKind =
  | { kind: 'slash'; name: string; args: string; extra: string }
  | { kind: 'stdout'; text: string; extra: string }
  | { kind: 'stderr'; text: string; extra: string }
  | { kind: 'cockpit_prompt'; text: string }
  | { kind: 'plain'; text: string }
  | { kind: 'hidden' }

function parseUserText(raw: string): UserTextKind {
  const text = raw
  // 1) cockpit 跨 agent 转发的 prompt(优先,因为可能含巨大上下文)
  if (/^#\s*Original Session\b/m.test(text) && /^#\s*Current Request\b/m.test(text)) {
    return { kind: 'cockpit_prompt', text }
  }
  // 2) <local-command-caveat>...</local-command-caveat>:Claude 内部对模型说的话,对用户是噪音
  //    如果除了 caveat 没别的内容就整条隐藏
  const caveat = extractTag(text, 'local-command-caveat')
  if (caveat !== null) {
    const rest = stripWrappers(text, ['local-command-caveat'])
    if (!rest) return { kind: 'hidden' }
    // 有 caveat 又有别的内容,把别的内容当 plain 渲染
    return { kind: 'plain', text: rest }
  }
  // 3) slash 命令:<command-name> / <command-message> / <command-args> 任意顺序,任意一两个出现都算
  const cmdName = extractTag(text, 'command-name')
  const cmdMsg = extractTag(text, 'command-message')
  const cmdArgs = extractTag(text, 'command-args')
  if (cmdName || cmdMsg) {
    const name = (cmdName ?? cmdMsg ?? '').trim().replace(/^\//, '')
    const args = (cmdArgs ?? '').trim()
    const extra = stripWrappers(text, ['command-name', 'command-message', 'command-args'])
    return { kind: 'slash', name, args, extra }
  }
  // 4) <local-command-stdout> / <local-command-stderr>:本地命令输出
  const stdout = extractTag(text, 'local-command-stdout')
  if (stdout !== null) {
    const extra = stripWrappers(text, ['local-command-stdout'])
    return { kind: 'stdout', text: stdout.trim(), extra }
  }
  const stderr = extractTag(text, 'local-command-stderr')
  if (stderr !== null) {
    const extra = stripWrappers(text, ['local-command-stderr'])
    return { kind: 'stderr', text: stderr.trim(), extra }
  }
  return { kind: 'plain', text }
}

// 按 NormalizedEvent.type 分发(不变量 6:只消费 NormalizedEvent)。
export function EventItem({
  envelope,
  pair,
  actionVisibility = 'hover',
}: {
  envelope: EventEnvelope
  pair?: ToolPair
  actionVisibility?: 'visible' | 'hover'
}) {
  const ev = envelope.event

  switch (ev.type) {
    case 'user_text': {
      const parsed = parseUserText(ev.text)
      if (parsed.kind === 'hidden') return null
      const name = ev.targetAgent ? `You → ${agentLabel(ev.targetAgent)}` : 'You'
      return (
        <div className="event user">
          <div className="avatar user">你</div>
          <div className="bubble">
            <div className="event-name">{name}</div>
            <div className="bubble-body">
              {parsed.kind === 'slash' ? (
                <>
                  <SlashCommand name={parsed.name} args={parsed.args} />
                  {parsed.extra && <Markdown text={parsed.extra} />}
                </>
              ) : parsed.kind === 'cockpit_prompt' ? (
                <CockpitPrompt text={parsed.text} />
              ) : parsed.kind === 'stdout' || parsed.kind === 'stderr' ? (
                <>
                  <LocalCommandOutput stream={parsed.kind} text={parsed.text} />
                  {parsed.extra && <Markdown text={parsed.extra} />}
                </>
              ) : (
                <Markdown text={parsed.text} />
              )}
              <AttachmentReferences attachments={ev.attachments} />
            </div>
          </div>
        </div>
      )
    }
    case 'assistant_text': {
      const a = agentAvatarClass(ev.agent)
      const agentName = ev.agent ?? 'assistant'
      return (
        <div className="event assistant" data-agent={a.cls}>
          <div className={`avatar ${a.cls}`}>
            <AgentIcon agent={ev.agent} size={20} />
          </div>
          <div className="bubble">
            <div className="event-name">{agentLabel(agentName)}</div>
            <div className="bubble-body">
              <Markdown text={ev.text} />
            </div>
            <AgentMessageActions
              agent={agentName}
              text={ev.text}
              visibility={actionVisibility}
            />
          </div>
        </div>
      )
    }
    case 'thinking':
      return (
        <div className="event event-compact">
          <div className="compact-icon"><Icon name="bulb" /></div>
          <div className="bubble compact-bubble">
            <Thinking text={ev.text} />
          </div>
        </div>
      )
    case 'tool_use':
      return (
        <div className="event event-compact">
          <div className={`compact-icon ${agentAvatarClass(ev.agent).cls}`}><Icon name="wrench" /></div>
          <div className="bubble compact-bubble">
            {pair ? (
              <ToolCallCard pair={pair} readOnly={envelope.source === 'codex'} />
            ) : (
              <div className="tool-pending">
                <span className="tool-name">{ev.name}</span>
                <span className="tool-pending-hint">等待结果…</span>
              </div>
            )}
          </div>
        </div>
      )
    case 'usage': {
      // 0/0 没有信息量,跳过(streaming 早期常常是 0/0)。
      if (!ev.inputTokens && !ev.outputTokens) return null
      return (
        <div className="event event-compact">
          <div className="meta-pill" title="本步 token 消耗">
            <span className="meta-pill-label">tokens</span>
            <span>↑ {ev.inputTokens}</span>
            <span>↓ {ev.outputTokens}</span>
          </div>
        </div>
      )
    }
    case 'meta': {
      // 轮次终态(docs/05 §4.3):✓ completed / ✗ failed / ⊘ aborted
      if (ev.key === 'turn_status') {
        const v = (ev.value ?? {}) as { status?: string; error?: string; message?: string }
        const status = v.status ?? 'completed'
        if (status === 'completed') return null
        const icon = status === 'completed' ? '✓' : status === 'failed' ? '!' : '⊘'
        const title = status === 'completed' ? '本轮已完成' : status === 'failed' ? v.error ?? v.message ?? '本轮失败' : '本轮已中断'
        return (
          <div className={`turn-status ${status}`} title={title} aria-label={title}>
            <span>{icon}</span>
          </div>
        )
      }
      // 其它噪音 meta:不渲染,让 timeline 留给真正有信息量的事件。
      if (META_HIDDEN_KEYS.has(ev.key)) return null
      return (
        <div className="event event-compact">
          <div className="meta-pill subtle">
            <span className="meta-pill-label">{ev.key}</span>
          </div>
        </div>
      )
    }
    case 'followup_boundary':
      return null // boundary 由 timeline 渲染成分隔条
    default:
      return null
  }
}

function AttachmentReferences({
  attachments,
}: {
  attachments?: Extract<EventEnvelope['event'], { type: 'user_text' }>['attachments']
}) {
  if (!attachments?.length) return null
  return (
    <div className="event-attachments">
      {attachments.map((a, index) => (
        <div key={`${a.kind}-${a.path}-${index}`} className="event-attachment-wrap">
          {a.kind === 'image' && (
            <img
              className="event-attachment-preview"
              src={`/api/attachments/image?path=${encodeURIComponent(a.path)}`}
              alt={a.name}
            />
          )}
          <div className="event-attachment" title={a.path}>
            <Icon name={a.kind === 'directory' ? 'folder' : a.kind === 'image' ? 'image' : 'file-text'} size={13} />
            <span className="event-attachment-name">{a.name}</span>
            <span className="event-attachment-path">{a.path}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

function AgentMessageActions({
  agent,
  text,
  visibility,
}: {
  agent: string
  text: string
  visibility: 'visible' | 'hover'
}) {
  const [copied, setCopied] = useState<'plain' | 'review' | null>(null)

  const write = async (value: string, kind: 'plain' | 'review') => {
    await navigator.clipboard.writeText(value)
    setCopied(kind)
    window.setTimeout(() => {
      setCopied((cur) => (cur === kind ? null : cur))
    }, 1100)
  }

  const advanced = [
    `# ${agent} agent review 信息`,
    '',
    `这是 ${agent} agent 在 Cockpit 里的 review 信息。请把它当作待核验的代码审查上下文,结合当前仓库继续分析;如果结论成立,请协助给出修复方案或直接修改。`,
    '',
    '---',
    '',
    text.trim(),
  ].join('\n')

  return (
    <div className={`event-actions-row ${visibility === 'visible' ? 'is-visible' : 'is-hover'}`} onClick={(e) => e.stopPropagation()}>
      <button
        className={`event-action-btn ${copied === 'plain' ? 'copied' : ''}`}
        onClick={() => write(text, 'plain')}
        title="复制原文"
      >
        <Icon name={copied === 'plain' ? 'check' : 'copy'} size={12} />
        <span>{copied === 'plain' ? '已复制' : '复制'}</span>
      </button>
      <button
        className={`event-action-btn advanced ${copied === 'review' ? 'copied' : ''}`}
        onClick={() => write(advanced, 'review')}
        title="复制成 Claude Code 可直接接收的 review 上下文"
      >
        <Icon name={copied === 'review' ? 'check' : 'file-text'} size={12} />
        <span>{copied === 'review' ? '已复制' : '高级复制'}</span>
      </button>
    </div>
  )
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const empty = !text.trim()
  return (
    <div className="collapsible">
      <div className="collapsible-head" onClick={() => empty ? undefined : setOpen((v) => !v)}>
        <span>{empty ? '·' : open ? '▾' : '▸'}</span>
        <span>thinking</span>
        <span className="arg">
          {empty ? '加密 reasoning,无明文(Claude 仅返回 signature)' : text.replace(/\s+/g, ' ').slice(0, 96)}
        </span>
      </div>
      {open && !empty && (
        <div className="collapsible-body">
          <pre>{text}</pre>
        </div>
      )}
    </div>
  )
}

function SlashCommand({ name, args }: { name: string; args: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="slash-cmd">
      <div className="slash-cmd-head">
        <span className="slash-chip">/{name}</span>
        {args && (
          <button className="slash-toggle" onClick={() => setOpen((v) => !v)}>
            {open ? '收起参数' : '展开参数'}
          </button>
        )}
      </div>
      {open && args && (
        <pre className="slash-args">{args}</pre>
      )}
    </div>
  )
}

// 本地命令输出:把 <local-command-stdout> / <local-command-stderr> 渲染成终端风格小块。
function LocalCommandOutput({ stream, text }: { stream: 'stdout' | 'stderr'; text: string }) {
  if (!text) {
    return <div className="local-cmd-out empty">{stream === 'stderr' ? 'stderr' : 'stdout'}：(空)</div>
  }
  const short = text.length <= 200 && !text.includes('\n')
  return (
    <div className={`local-cmd-out ${stream}`}>
      <span className="local-cmd-tag">{stream}</span>
      {short ? <span className="local-cmd-inline">{text}</span> : <pre className="local-cmd-block">{text}</pre>}
    </div>
  )
}

// Cockpit 跨 agent 转发的 prompt:默认只显示 Current Request 这一段,
// 上文(Original Session / User Goal / Final Response …)折叠起来。
function CockpitPrompt({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const idx = text.search(/^#\s*Current Request\b/m)
  const head = idx > 0 ? text.slice(0, idx).trim() : ''
  const tailRaw = idx >= 0 ? text.slice(idx).replace(/^#\s*Current Request\b.*\n?/, '') : text
  // 跳过那行固定的"请以 XX 的身份回应…"。
  const tailLines = tailRaw.split('\n')
  const filtered: string[] = []
  let skippedIntro = false
  for (const ln of tailLines) {
    if (!skippedIntro && /^请以\s+\S+\s+的身份/.test(ln.trim())) {
      skippedIntro = true
      continue
    }
    filtered.push(ln)
  }
  const currentRequest = filtered.join('\n').trim()
  return (
    <div className="cockpit-prompt">
      {head && (
        <div className="cockpit-prompt-head">
          <button className="cockpit-prompt-toggle" onClick={() => setOpen((v) => !v)}>
            {open ? '▾' : '▸'} 转发上下文 ({head.length} 字符)
          </button>
          {open && <pre className="cockpit-prompt-context">{head}</pre>}
        </div>
      )}
      <Markdown text={currentRequest || text} />
    </div>
  )
}
