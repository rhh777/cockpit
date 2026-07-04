import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentName, ChatAttachment } from '../lib/types'
import { Icon } from './Icon'
import { AgentIcon } from './AgentIcon'
import { AgentPicker } from './AgentPicker'
import {
  PREFERENCES_CHANGED_EVENT,
  readDefaultAgent,
  setDefaultAgent,
} from '../lib/preferences'
import { parseMentions } from '../lib/mentions'
import { AGENT_OPTIONS, labelForAgent } from '../lib/agents'

export type SendMode = 'followup' | 'native'

function mentionDraft(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const lineStart = Math.max(before.lastIndexOf('\n') + 1, 0)
  const lineBeforeCaret = before.slice(lineStart)
  const match = lineBeforeCaret.match(/(^|[\s([{])@([a-z0-9_-]*)$/i)
  if (!match) return null
  return { start: lineStart + lineBeforeCaret.length - match[2].length - 1, query: match[2].toLowerCase() }
}

// CLI 选项分组:每个 agent 一组或多组(model / reasoning),每组独立持久化。
// value === '' 表示 Default,不传对应 flag,完全交给 CLI 自己决定。
type CliField = 'model' | 'effort'
type CliOption = { value: string; label: string; hint?: string }
type CliGroup = { key: CliField; label: string; flag: string; options: CliOption[] }
type CliSelection = Partial<Record<CliField, string>>

const CLI_GROUPS: Record<AgentName, CliGroup[]> = {
  claude: [
    {
      key: 'model',
      label: '模型',
      flag: '--model',
      options: [
        { value: '', label: 'Default', hint: 'CLI 默认' },
        { value: 'claude-opus-4-8', label: 'Opus 4.8' },
        { value: 'claude-opus-4-7', label: 'Opus 4.7' },
        { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
        { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
      ],
    },
    {
      key: 'effort',
      label: '推理',
      flag: '--effort',
      options: [
        { value: '', label: 'Default', hint: 'CLI 默认' },
        { value: 'low', label: '低' },
        { value: 'medium', label: '中' },
        { value: 'high', label: '高' },
        { value: 'xhigh', label: '超高' },
        { value: 'max', label: '极致' },
      ],
    },
  ],
  codex: [
    {
      key: 'model',
      label: '模型',
      flag: '-m',
      options: [
        { value: '', label: 'Default', hint: 'CLI 默认' },
        { value: 'gpt-5.5', label: 'GPT-5.5' },
        { value: 'gpt-5.4-mini', label: 'GPT-5.4-Mini' },
      ],
    },
    {
      key: 'effort',
      label: '推理',
      flag: 'model_reasoning_effort',
      options: [
        { value: '', label: 'Default', hint: 'CLI 默认' },
        { value: 'low', label: '低' },
        { value: 'medium', label: '中' },
        { value: 'high', label: '高' },
        { value: 'xhigh', label: '超高' },
      ],
    },
  ],
  opencode: [
    {
      key: 'model',
      label: '模型',
      flag: '--model',
      options: [
        { value: '', label: 'Default', hint: 'OpenCode 默认' },
        { value: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet' },
        { value: 'openai/gpt-5.5', label: 'GPT-5.5' },
        { value: 'qwen/qwen3-coder-plus', label: 'Qwen Coder' },
      ],
    },
    {
      key: 'effort',
      label: '变体',
      flag: '--variant',
      options: [
        { value: '', label: 'Default', hint: 'OpenCode 默认' },
        { value: 'low', label: '低' },
        { value: 'medium', label: '中' },
        { value: 'high', label: '高' },
        { value: 'max', label: '极致' },
      ],
    },
  ],
  cursor: [
    {
      key: 'model',
      label: '模型',
      flag: '--model',
      options: [
        { value: '', label: 'Default', hint: 'Cursor 默认' },
        { value: 'auto', label: 'Auto' },
        { value: 'gpt-5.5', label: 'GPT-5.5' },
        { value: 'claude-sonnet-4-6', label: 'Claude Sonnet' },
      ],
    },
  ],
}

const REVIEW_TEMPLATE =
  'Please review the above session for correctness, design issues, and potential bugs. 如果有问题, 指出具体问题与改进建议。如果没有, 则回答没有。'

type CliSelectionByAgent = Partial<Record<AgentName, CliSelection>>
type AttachmentDraft =
  | Pick<Extract<ChatAttachment, { kind: 'file' | 'directory' }>, 'kind' | 'path' | 'name'>
  | { kind: 'imageData'; dataUrl: string; name: string; mimeType: string }

export function FollowupComposer({
  hasActiveStreams,
  sessionAgent,
  nativeAvailable,
  onSend,
  onNativeSend,
  onCancelAll,
  groupMode = false,
}: {
  hasActiveStreams: boolean
  sessionAgent: AgentName
  nativeAvailable: boolean
  groupMode?: boolean
  /** 一次可能发到多个 agent(@-mentions 拆分)。 */
  onSend: (
    text: string,
    agents: AgentName[],
    options?: CliSelection | CliSelectionByAgent,
    attachments?: AttachmentDraft[],
  ) => void
  onNativeSend: (text: string, attachments?: AttachmentDraft[]) => void
  onCancelAll: () => void
}) {
  const [text, setText] = useState('')
  const [agent, setAgent] = useState<AgentName>('claude')
  const [mode, setMode] = useState<SendMode>('followup')
  // 按当前 composer 临时记录 model / reasoning 选择。空串 = Default。
  // 不跨 session 持久化,避免新开的会话继承上一次临时挑的模型。
  const [cliByAgent, setCliByAgent] = useState<Record<AgentName, CliSelection>>({
    claude: {},
    codex: {},
    opencode: {},
    cursor: {},
  })
  const [modelMenuOpen, setModelMenuOpen] = useState<AgentName | null>(null)
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false)
  const [advancedMenuOpen, setAdvancedMenuOpen] = useState(false)
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([])
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [reviewDraft, setReviewDraft] = useState(false)
  const [mentionMenu, setMentionMenu] = useState<{ start: number; query: string; active: number } | null>(null)
  const [mentionConfirm, setMentionConfirm] = useState<AgentName | null>(null)
  const mentionConfirmTimer = useRef<number | null>(null)
  const modelMenuRef = useRef<HTMLDivElement | null>(null)
  const attachmentMenuRef = useRef<HTMLDivElement | null>(null)
  const advancedMenuRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    setAgent(readDefaultAgent())
  }, [])

  useEffect(() => {
    const onPrefs = () => {
      setAgent(readDefaultAgent())
    }
    window.addEventListener(PREFERENCES_CHANGED_EVENT, onPrefs)
    return () => window.removeEventListener(PREFERENCES_CHANGED_EVENT, onPrefs)
  }, [])

  useEffect(() => {
    if (!modelMenuOpen && !attachmentMenuOpen && !advancedMenuOpen) return
    const onDoc = (e: MouseEvent) => {
      if (!modelMenuRef.current?.contains(e.target as Node)) setModelMenuOpen(null)
      if (!attachmentMenuRef.current?.contains(e.target as Node)) setAttachmentMenuOpen(false)
      if (!advancedMenuRef.current?.contains(e.target as Node)) setAdvancedMenuOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [modelMenuOpen, attachmentMenuOpen, advancedMenuOpen])

  const mentions = useMemo(() => parseMentions(text), [text])
  const usingNative = !groupMode && mode === 'native' && nativeAvailable
  const targets = groupMode ? mentions : usingNative ? [sessionAgent] : mentions.length ? mentions : [agent]
  const usingMentions = !usingNative && mentions.length > 0
  const mentionOptions = useMemo(() => {
    if (!mentionMenu) return []
    return AGENT_OPTIONS.filter((a) => a.value.toLowerCase().startsWith(mentionMenu.query))
  }, [mentionMenu])

  useEffect(() => {
    if ((groupMode || !nativeAvailable) && mode === 'native') setMode('followup')
  }, [nativeAvailable, mode, groupMode])

  useEffect(() => {
    return () => {
      if (mentionConfirmTimer.current) window.clearTimeout(mentionConfirmTimer.current)
    }
  }, [])

  const chooseMode = (next: SendMode) => {
    const resolved = next === 'native' && !nativeAvailable ? 'followup' : next
    setMode(resolved)
    if (resolved === 'native') setReviewDraft(false)
  }

  const pickReviewTemplate = () => {
    const reviewAgent = sessionAgent === 'codex' ? 'claude' : 'codex'
    setMode('followup')
    setAgent(reviewAgent)
    setModelMenuOpen(null)
    setAdvancedMenuOpen(false)
    setReviewDraft(true)
    setText(REVIEW_TEMPLATE)
  }

  const send = () => {
    const t = text.trim()
    if (!t && attachments.length === 0) return
    const outgoing = attachments.length ? attachments : undefined
    if (usingNative) {
      onNativeSend(t, outgoing)
    } else {
      if (!usingMentions && !groupMode) setDefaultAgent(agent)
      // 单 agent 场景按当前 agent 偏好透传;@mentions 多目标下让 caller 走默认,避免一个
      // 模型设置被错配到另一个 agent。
      const options = groupMode ? cliByAgent : !usingMentions ? cliByAgent[agent] : undefined
      onSend(t, targets, options, outgoing)
    }
    setText('')
    setAttachments([])
    setAttachmentError(null)
    setReviewDraft(false)
  }

  const addPathAttachments = (kind: 'file' | 'directory', paths: string[]) => {
    setAttachmentError(null)
    setAttachments((prev) => {
      const seen = new Set(prev.map((a) => ('path' in a ? `${a.kind}:${a.path}` : `${a.kind}:${a.name}`)))
      const next = [...prev]
      for (const p of paths) {
        const name = p.split(/[\\/]/).filter(Boolean).at(-1) ?? p
        const key = `${kind}:${p}`
        if (!seen.has(key)) {
          seen.add(key)
          next.push({ kind, path: p, name })
        }
      }
      return next
    })
  }

  const pickLocalPaths = async (kind: 'file' | 'directory'): Promise<string[]> => {
    try {
      const res = await fetch(`/api/native-dialog/open?kind=${kind}`, { method: 'POST' })
      if (res.ok) {
        const body = (await res.json()) as { paths?: string[] }
        return Array.isArray(body.paths) ? body.paths : []
      }
    } catch {
      /* fall through to Electron preload */
    }

    if (window.cockpitNative) {
      return kind === 'file' ? window.cockpitNative.pickFiles() : window.cockpitNative.pickDirectory()
    }
    throw new Error('当前环境无法打开本地选择框')
  }

  const pickFiles = async () => {
    setAttachmentMenuOpen(false)
    try {
      const paths = await pickLocalPaths('file')
      addPathAttachments('file', paths)
    } catch (err) {
      setAttachmentError(String((err as Error)?.message ?? err))
    }
  }

  const pickDirectory = async () => {
    setAttachmentMenuOpen(false)
    try {
      const paths = await pickLocalPaths('directory')
      addPathAttachments('directory', paths)
    } catch (err) {
      setAttachmentError(String((err as Error)?.message ?? err))
    }
  }

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
  }

  const attachPastedImages = (items: DataTransferItemList) => {
    const imageItems = [...items].filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    if (imageItems.length === 0) return false
    setAttachmentError(null)
    for (const item of imageItems) {
      const file = item.getAsFile()
      if (!file) continue
      const reader = new FileReader()
      reader.onload = () => {
        if (typeof reader.result !== 'string') return
        setAttachments((prev) => [
          ...prev,
          {
            kind: 'imageData',
            dataUrl: reader.result as string,
            name: file.name || `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}`,
            mimeType: file.type,
          },
        ])
      }
      reader.readAsDataURL(file)
    }
    return true
  }

  const pickCli = (targetAgent: AgentName, field: CliField, value: string) => {
    setCliByAgent((m) => ({ ...m, [targetAgent]: { ...m[targetAgent], [field]: value } }))
  }

  const refreshMentionMenu = (nextText = text, caret = textareaRef.current?.selectionStart ?? nextText.length) => {
    const draft = mentionDraft(nextText, caret)
    setMentionMenu((prev) => {
      if (!draft) return null
      const active =
        prev && prev.start === draft.start && prev.query === draft.query
          ? prev.active
          : 0
      return { ...draft, active }
    })
  }

  const pickMention = (picked?: AgentName) => {
    if (!mentionMenu || !picked) return
    const el = textareaRef.current
    const caret = el?.selectionStart ?? text.length
    const before = text.slice(0, mentionMenu.start)
    const after = text.slice(caret)
    const insert = `@${picked} `
    const next = `${before}${insert}${after}`
    const nextCaret = before.length + insert.length
    setText(next)
    setAgent(picked)
    setMentionMenu(null)
    setMentionConfirm(picked)
    if (mentionConfirmTimer.current) window.clearTimeout(mentionConfirmTimer.current)
    mentionConfirmTimer.current = window.setTimeout(() => setMentionConfirm(null), 1400)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(nextCaret, nextCaret)
    })
  }

  const groups = CLI_GROUPS[agent]
  // 按钮 label:把每个 group 的当前选项串成 "GPT-5.5 · 中";全 Default 时显示 "Default"。
  const triggerLabel = (targetAgent: AgentName) => {
    const parts = (CLI_GROUPS[targetAgent] ?? []).map((g) => {
      const v = cliByAgent[targetAgent]?.[g.key] ?? ''
      return g.options.find((o) => o.value === v)?.label ?? 'Default'
    })
    return parts.every((p) => p === 'Default') ? 'Default' : parts.join(' · ')
  }

  const renderModelPicker = (targetAgent: AgentName, withAgent = false) => {
    const targetGroups = CLI_GROUPS[targetAgent] ?? []
    const targetSel = cliByAgent[targetAgent] ?? {}
    return (
      <div className={`model-picker ${withAgent ? 'group-model-picker' : ''}`}>
        <button
          className="model-picker-btn"
          onClick={() => setModelMenuOpen((v) => (v === targetAgent ? null : targetAgent))}
          title={`${labelForAgent(targetAgent)} CLI 参数`}
        >
          <Icon name="settings" size={12} />
          {withAgent && <AgentIcon agent={targetAgent} size={16} />}
          {withAgent && <span className="model-picker-agent">{labelForAgent(targetAgent)}</span>}
          <span>{triggerLabel(targetAgent)}</span>
          <span className="model-picker-caret">▾</span>
        </button>
        {modelMenuOpen === targetAgent && (
          <div className="model-popover" role="menu">
            {targetGroups.map((g, gi) => (
              <div key={g.key} className="model-popover-group">
                {gi > 0 && <div className="model-popover-sep" />}
                <div className="model-popover-title">{g.label}</div>
                {g.options.map((o) => {
                  const active = (targetSel[g.key] ?? '') === o.value
                  return (
                    <button
                      key={o.value || '__default'}
                      className={`model-popover-item ${active ? 'active' : ''}`}
                      onClick={() => pickCli(targetAgent, g.key, o.value)}
                    >
                      <span>{o.label}</span>
                      {o.hint && <span className="model-popover-hint">{o.hint}</span>}
                      {active && <Icon name="check" size={12} />}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  const agentLabel = labelForAgent(sessionAgent)

  const sendTitle = usingNative
    ? `通过本机 ${agentLabel} CLI 续写原生 session`
    : groupMode && targets.length === 0
    ? '只记录到群聊;输入 @ 可选择成员回答'
    : usingMentions
    ? `并行发送给 ${targets.map(labelForAgent).join('、')}`
    : `通过本机 ${labelForAgent(agent)} CLI 运行,只读权限`
  const reviewTargets = usingMentions ? targets : [agent]
  const showReviewTarget = reviewDraft && !usingNative && !groupMode && reviewTargets.length > 0

  return (
    <div className="composer">
      <div className="composer-controls">
        <div className="composer-main-controls">
          {!groupMode && (
            <>
              <div className="send-mode-control" aria-describedby="send-mode-help">
                <button
                  className={`send-mode-item ${mode === 'followup' ? 'active' : ''}`}
                  onClick={() => chooseMode('followup')}
                  title="在 Cockpit 中基于当前上下文追问,不修改原生会话;CLI 以只读权限运行"
                >
                  <Icon name="arrow-up-right" size={12} />
                  <span>Cockpit 追问</span>
                </button>
                <button
                  className={`send-mode-item ${usingNative ? 'active' : ''}`}
                  onClick={() => chooseMode('native')}
                  disabled={!nativeAvailable}
                  title={
                    nativeAvailable
                      ? `写回原 ${agentLabel} 会话历史`
                      : '只有 Claude/Codex 原生会话支持回到原会话'
                  }
                >
                  <Icon name="rotate-ccw" size={12} />
                  <span>回到原会话</span>
                </button>
                <div id="send-mode-help" className="composer-help-popover" role="tooltip">
                  <div className="composer-help-title">发送方式</div>
                  <div><strong>Cockpit 追问</strong>: 只追加到 Cockpit,不改原生历史;CLI 只读。</div>
                  <div><strong>回到原会话</strong>: 发送到原 Claude/Codex 会话,会进入原生历史。</div>
                </div>
              </div>
            </>
          )}

          {groupMode ? (
            <div className="group-model-settings" ref={modelMenuRef}>
              {AGENT_OPTIONS.map((a) => (
                <div key={a.value}>{renderModelPicker(a.value, true)}</div>
              ))}
            </div>
          ) : usingNative ? (
            <span className={`native-agent-pill agent-${sessionAgent}`}>
              <AgentIcon agent={sessionAgent} size={16} /> {agentLabel}
            </span>
          ) : usingMentions ? (
            <div className="mention-chips">
              {targets.map((a) => (
                <span key={a} className={`mention-chip agent-${a}`}>
                  <AgentIcon agent={a} size={14} /> @{a}
                </span>
              ))}
            </div>
          ) : (
            <AgentPicker value={agent} onChange={setAgent} />
          )}
        </div>

        {!groupMode && !usingNative && !usingMentions && groups.length > 0 && (
          <div ref={modelMenuRef}>
            {renderModelPicker(agent)}
          </div>
        )}
      </div>
      <div className="composer-input-area">
        <div className="composer-input-wrap group-composer-shell">
        {attachments.length > 0 && (
          <div className="attachment-tray" aria-label="附件">
            {attachments.map((a, index) => (
              <span key={`${a.kind}-${index}-${a.name}`} className={`attachment-chip ${a.kind === 'imageData' ? 'has-preview' : ''}`}>
                {a.kind === 'imageData' ? (
                  <img className="attachment-chip-preview" src={a.dataUrl} alt={a.name} />
                ) : (
                  <Icon name={a.kind === 'directory' ? 'folder' : 'file-text'} size={12} />
                )}
                <span>{a.name}</span>
                <button onClick={() => removeAttachment(index)} title="移除附件" aria-label="移除附件">
                  <Icon name="close" size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
        {attachmentError && <div className="attachment-error">{attachmentError}</div>}
        <textarea
          ref={textareaRef}
          className="composer-input"
          placeholder={
            groupMode
              ? '群聊消息;输入 @ 可选择成员回答…'
              : usingNative
              ? `回到原 ${agentLabel} 会话继续发送…`
              : '继续追问,或输入 @ 选择多个 agent 同时回答…'
          }
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            if (!e.target.value.trim()) setReviewDraft(false)
            refreshMentionMenu(e.target.value, e.target.selectionStart)
          }}
          onPaste={(e) => {
            if (attachPastedImages(e.clipboardData.items)) e.preventDefault()
          }}
          onClick={() => refreshMentionMenu()}
          onKeyUp={(e) => {
            if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key)) return
            refreshMentionMenu()
          }}
          onKeyDown={(e) => {
            if (mentionMenu && mentionOptions.length > 0) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                const dir = e.key === 'ArrowDown' ? 1 : -1
                setMentionMenu((m) =>
                  m ? { ...m, active: (m.active + dir + mentionOptions.length) % mentionOptions.length } : m,
                )
                return
              }
              if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
                e.preventDefault()
                pickMention(mentionOptions[mentionMenu.active]?.value)
                return
              }
              if (e.key === 'Escape') {
                setMentionMenu(null)
                return
              }
            }
            const composing = (e.nativeEvent as KeyboardEvent).isComposing
            if (e.key === 'Enter' && !e.altKey && !e.shiftKey && !composing) {
              e.preventDefault()
              send()
            }
          }}
          rows={2}
        />
        {mentionMenu && mentionOptions.length > 0 && (
          <div className="mention-menu" role="listbox">
            {mentionOptions.map((a, index) => (
              <button
                key={a.value}
                className={`mention-menu-item ${index === mentionMenu.active ? 'active' : ''} agent-${a.value}`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  pickMention(a.value)
                }}
                role="option"
                aria-selected={index === mentionMenu.active}
              >
                <AgentIcon agent={a.value} size={16} />
                <span>@{a.value}</span>
                <span className="mention-menu-label">{a.label}</span>
              </button>
            ))}
          </div>
        )}
        {mentionConfirm && (
          <div className={`mention-confirm agent-${mentionConfirm}`} aria-live="polite">
            <AgentIcon agent={mentionConfirm} size={15} />
            <span>已添加 @{mentionConfirm}</span>
          </div>
        )}
        <div className="composer-action-bar">
          <div className="composer-action-left">
            {!hasActiveStreams && (
              <div className="attachment-menu-wrap" ref={attachmentMenuRef}>
                <button
                  className="composer-attach-btn"
                  onClick={() => setAttachmentMenuOpen((v) => !v)}
                  title="添加附件"
                  aria-label="添加附件"
                  aria-expanded={attachmentMenuOpen}
                >
                  <Icon name="paperclip" size={16} />
                </button>
                {attachmentMenuOpen && (
                  <div className="attachment-menu">
                    <button onMouseDown={(e) => e.preventDefault()} onClick={pickFiles}>
                      <Icon name="file-text" size={13} />
                      <span>文件</span>
                    </button>
                    <button onMouseDown={(e) => e.preventDefault()} onClick={pickDirectory}>
                      <Icon name="folder" size={13} />
                      <span>文件夹</span>
                    </button>
                  </div>
                )}
              </div>
            )}
            {!hasActiveStreams && !usingNative && (
              <div className="advanced-menu-wrap" ref={advancedMenuRef}>
                <button
                  className="composer-attach-btn"
                  onClick={() => setAdvancedMenuOpen((v) => !v)}
                  title="高级"
                  aria-label="高级"
                  aria-expanded={advancedMenuOpen}
                >
                  <Icon name="more-horizontal" size={16} />
                </button>
                {advancedMenuOpen && (
                  <div className="advanced-menu">
                    <button onMouseDown={(e) => e.preventDefault()} onClick={pickReviewTemplate}>
                      <Icon name="sparkle" size={13} />
                      <span>Review</span>
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="composer-action-right">
            {showReviewTarget && (
              <div className="review-target-strip" role="status" aria-live="polite">
                <span className="review-target-label">
                  <Icon name="sparkle" size={13} />
                  Review
                </span>
                <span className="review-target-arrow">→</span>
                <span className="review-target-agents">
                  {reviewTargets.map((a) => (
                    <span key={a} className={`review-target-agent agent-${a}`}>
                      <AgentIcon agent={a} size={15} />
                      {labelForAgent(a)}
                    </span>
                  ))}
                </span>
              </div>
            )}
            <button
              className={`send-btn primary-action ${hasActiveStreams ? 'is-canceling' : 'is-ready'}`}
              onClick={hasActiveStreams ? onCancelAll : send}
              disabled={!hasActiveStreams && !text.trim() && attachments.length === 0}
              title={hasActiveStreams ? '取消当前所有正在生成的回复' : `${sendTitle}; Enter 发送, Alt+Enter 换行`}
              aria-label={hasActiveStreams ? '取消生成' : '发送'}
            >
              {hasActiveStreams ? (
                <>
                  <span className="send-pulse" aria-hidden />
                  <Icon name="close" size={14} />
                </>
              ) : (
                <Icon name="send" size={14} />
              )}
            </button>
          </div>
        </div>
      </div>
      </div>
    </div>
  )
}
