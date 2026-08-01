import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentName, ChatAttachment } from '../lib/types'
import { Icon } from './Icon'
import { AgentIcon } from './AgentIcon'
import { AgentPicker } from './AgentPicker'
import {
  PREFERENCES_CHANGED_EVENT,
  readAllCliSelections,
  readDefaultAgent,
} from '../lib/preferences'
import { scanMentions, splitMentionSegments, type MentionTarget } from '../lib/mentions'
import { labelForAgent } from '../lib/agents'
import { fetchAgentCapabilities, type AgentCliCapabilitiesDTO } from '../lib/api'
import type { ApprovalMode, RunPermissions } from '../lib/types'
import { useI18n, type MessageKey } from '../lib/i18n'
import { pickLocalPaths } from '../lib/native-dialog'
import { useEnabledAgentOptions } from '../hooks/useEnabledAgents'
import { FALLBACK_MODEL_OPTIONS } from '../lib/cli-options'

export type SendMode = 'followup' | 'native'
type GroupDiscussionMode = 'parallel' | 'serial'
type SerialPreset = 'architecture-first' | 'implementation-first' | 'peer-review'

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
// label / hint 是不翻译的内容(模型专有名、服务端返回的补充说明);
// labelKey / hintKey 是需要跟随界面语言的静态文案。
type CliOption = {
  value: string
  label?: string
  labelKey?: MessageKey
  hint?: string
  hintKey?: MessageKey
}
type CliGroup = { key: CliField; labelKey: MessageKey; flag: string; options: CliOption[] }
type CliSelection = Partial<Record<CliField, string>>

const CLI_GROUPS: Record<AgentName, CliGroup[]> = {
  claude: [
    {
      key: 'model',
      labelKey: 'cli.model',
      flag: '--model',
      options: [{ value: '', label: 'Default', hintKey: 'cli.default' }, ...FALLBACK_MODEL_OPTIONS.claude],
    },
    {
      key: 'effort',
      labelKey: 'cli.reasoning',
      flag: '--effort',
      options: [
        { value: '', label: 'Default', hintKey: 'cli.default' },
        { value: 'low', labelKey: 'common.low' },
        { value: 'medium', labelKey: 'common.medium' },
        { value: 'high', labelKey: 'common.high' },
        { value: 'xhigh', labelKey: 'common.xhigh' },
        { value: 'max', labelKey: 'common.max' },
      ],
    },
  ],
  codex: [
    {
      key: 'model',
      labelKey: 'cli.model',
      flag: '-m',
      options: [{ value: '', label: 'Default', hintKey: 'cli.default' }, ...FALLBACK_MODEL_OPTIONS.codex],
    },
    {
      key: 'effort',
      labelKey: 'cli.reasoning',
      flag: 'model_reasoning_effort',
      options: [
        { value: '', label: 'Default', hintKey: 'cli.default' },
        { value: 'low', labelKey: 'common.low' },
        { value: 'medium', labelKey: 'common.medium' },
        { value: 'high', labelKey: 'common.high' },
        { value: 'xhigh', labelKey: 'common.xhigh' },
      ],
    },
  ],
  opencode: [
    {
      key: 'model',
      labelKey: 'cli.model',
      flag: '--model',
      options: [{ value: '', label: 'Default', hintKey: 'cli.openCodeDefault' }, ...FALLBACK_MODEL_OPTIONS.opencode],
    },
    {
      key: 'effort',
      labelKey: 'cli.variant',
      flag: '--variant',
      options: [
        { value: '', label: 'Default', hintKey: 'cli.openCodeDefault' },
        { value: 'low', labelKey: 'common.low' },
        { value: 'medium', labelKey: 'common.medium' },
        { value: 'high', labelKey: 'common.high' },
        { value: 'max', labelKey: 'common.max' },
      ],
    },
  ],
  cursor: [
    {
      key: 'model',
      labelKey: 'cli.model',
      flag: '--model',
      options: [{ value: '', label: 'Default', hintKey: 'cli.cursorDefault' }, ...FALLBACK_MODEL_OPTIONS.cursor],
    },
  ],
}

type CliSelectionByAgent = Partial<Record<AgentName, CliSelection>>
type AttachmentDraft =
  | Pick<Extract<ChatAttachment, { kind: 'file' | 'directory' }>, 'kind' | 'path' | 'name'>
  | { kind: 'imageData'; dataUrl: string; name: string; mimeType: string }

const PERMISSION_OPTIONS: { mode: ApprovalMode; labelKey: MessageKey; hintKey: MessageKey }[] = [
  { mode: 'ask', labelKey: 'perm.ask', hintKey: 'perm.askHint' },
  { mode: 'auto-safe', labelKey: 'perm.autoSafe', hintKey: 'perm.autoSafeHint' },
  { mode: 'full-access', labelKey: 'perm.full', hintKey: 'perm.fullHint' },
]

// CLI 选项的显示名:优先 i18n key,其次不翻译的字面量(模型名 / 服务端 hint)。
function optionLabel(o: CliOption, t: (k: MessageKey) => string): string {
  return o.labelKey ? t(o.labelKey) : o.label ?? o.value
}

const SERIAL_PRESETS: { value: SerialPreset; labelKey: MessageKey; hintKey: MessageKey }[] = [
  { value: 'architecture-first', labelKey: 'serial.presetArchitecture', hintKey: 'serial.presetArchitectureHint' },
  { value: 'implementation-first', labelKey: 'serial.presetImplementation', hintKey: 'serial.presetImplementationHint' },
  { value: 'peer-review', labelKey: 'serial.presetPeer', hintKey: 'serial.presetPeerHint' },
]

const MODEL_POPOVER_WIDTH = 360
const MODEL_POPOVER_MARGIN = 12

function permissionsForMode(mode: ApprovalMode): RunPermissions {
  if (mode === 'full-access') {
    return {
      mode,
      allowNetwork: true,
      allowWorkspaceWrite: true,
      allowOutsideWorkspaceWrite: false,
      allowShell: true,
    }
  }
  if (mode === 'auto-safe') {
    return {
      mode,
      allowNetwork: true,
      allowWorkspaceWrite: true,
      allowOutsideWorkspaceWrite: false,
      allowShell: true,
    }
  }
  return {
    mode: 'ask',
    allowNetwork: false,
    allowWorkspaceWrite: false,
    allowOutsideWorkspaceWrite: false,
    allowShell: false,
  }
}

export function FollowupComposer({
  hasActiveStreams,
  sessionAgent,
  nativeAvailable,
  onSend,
  onNativeSend,
  onCancelAll,
  cwd,
  groupMode = false,
  groupDefaultDiscussionMode = 'parallel',
  codexAcceleratedMode = false,
  onCodexAcceleratedModeChange,
  externalDraft,
}: {
  hasActiveStreams: boolean
  sessionAgent: AgentName
  nativeAvailable: boolean
  groupMode?: boolean
  groupDefaultDiscussionMode?: GroupDiscussionMode
  /** 一次可能发到多个 agent(@-mentions 拆分)。 */
  onSend: (
    text: string,
    agents: AgentName[],
    options?: CliSelection | CliSelectionByAgent,
    attachments?: AttachmentDraft[],
    permissions?: RunPermissions,
    extras?: {
      codexAcceleratedMode?: boolean
      groupMode?: GroupDiscussionMode
      groupParticipants?: AgentName[]
      serial?: {
        participants?: AgentName[]
        firstAgent?: AgentName
        maxSteps?: number
        stopOnConsensus?: boolean
        preset?: 'architecture-first' | 'implementation-first' | 'peer-review'
      }
    },
  ) => void
  onNativeSend: (
    text: string,
    attachments?: AttachmentDraft[],
    writeMode?: 'read-only' | 'trusted',
  ) => void
  onCancelAll: () => void
  cwd?: string | null
  /** Phase 2 opt-in:「Codex 加速模式」当前 thread 是否已启用。由 SessionDetail per-thread 持久化。 */
  codexAcceleratedMode?: boolean
  onCodexAcceleratedModeChange?: (next: boolean) => void
  /** Lets adjacent workbenches prepare a message without sending it. */
  externalDraft?: { text: string; nonce: number } | null
}) {
  const { t } = useI18n()
  const { enabledAgents, enabledSet, options: enabledAgentOptions } = useEnabledAgentOptions()
  const [text, setText] = useState('')
  const [agent, setAgent] = useState<AgentName>(() => readDefaultAgent())
  const [mode, setMode] = useState<SendMode>('followup')
  const [groupDiscussionMode, setGroupDiscussionMode] = useState<GroupDiscussionMode>('parallel')
  const [serialMaxSteps, setSerialMaxSteps] = useState(6)
  // docs/13 Phase 2:preset / 首位 agent / 参与成员都由用户选,不再写死。
  const [serialPreset, setSerialPreset] = useState<SerialPreset>('architecture-first')
  const [serialFirstAgent, setSerialFirstAgent] = useState<AgentName | 'auto'>('auto')
  // 临时排除的成员(docs/13:「允许临时取消某些 agent」)。存排除集而不是包含集,
  // 这样 group 成员变化时新成员默认参与,不会因为旧快照被漏掉。
  const [serialExcluded, setSerialExcluded] = useState<Set<AgentName>>(new Set())
  const [groupAgents, setGroupAgents] = useState<AgentName[]>(() => enabledAgents)
  // 每个 composer 从设置中的模型/推理默认值初始化;在这里临时修改只影响当前 composer。
  const [cliByAgent, setCliByAgent] = useState<Record<AgentName, CliSelection>>(() => readAllCliSelections())
  const [modelMenuOpen, setModelMenuOpen] = useState<AgentName | null>(null)
  const [cliCapabilities, setCliCapabilities] = useState<Partial<Record<AgentName, AgentCliCapabilitiesDTO>>>({})
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false)
  const [advancedMenuOpen, setAdvancedMenuOpen] = useState(false)
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false)
  const [modelMenuRect, setModelMenuRect] = useState<{ left: number; top: number; bottom: number; width: number } | null>(null)
  const [permissionMode, setPermissionMode] = useState<ApprovalMode>('ask')
  // Native resume 独立开关:每次发送后归零,防止粘性授权。二值:
  //   false  → --sandbox read-only / --allowedTools Read,Grep,Glob(默认预览)
  //   true   → --dangerously-bypass-approvals-and-sandbox / --permission-mode bypassPermissions
  // 不接 cockpit 三档权限选择器 —— CLI headless 接不住 approval 回调。见 docs/10。
  const [nativeTrustWrite, setNativeTrustWrite] = useState(false)
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([])
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [reviewDraft, setReviewDraft] = useState(false)
  const [mentionMenu, setMentionMenu] = useState<{ start: number; query: string; active: number } | null>(null)
  const [mentionConfirm, setMentionConfirm] = useState<MentionTarget | null>(null)
  const mentionConfirmTimer = useRef<number | null>(null)
  const modelMenuRef = useRef<HTMLDivElement | null>(null)
  const attachmentMenuRef = useRef<HTMLDivElement | null>(null)
  const advancedMenuRef = useRef<HTMLDivElement | null>(null)
  const permissionMenuRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const highlightRef = useRef<HTMLDivElement | null>(null)
  const mentionSegments = useMemo(() => splitMentionSegments(text), [text])
  useEffect(() => {
    if (!externalDraft) return
    setMode('followup')
    setText(externalDraft.text)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(externalDraft.text.length, externalDraft.text.length)
    })
  }, [externalDraft])

  useEffect(() => {
    const preferred = readDefaultAgent()
    setAgent(enabledSet.has(preferred) ? preferred : enabledAgents[0])
  }, [sessionAgent, enabledAgents, enabledSet])

  useEffect(() => {
    const refreshDefaults = () => setCliByAgent(readAllCliSelections())
    window.addEventListener(PREFERENCES_CHANGED_EVENT, refreshDefaults)
    return () => window.removeEventListener(PREFERENCES_CHANGED_EVENT, refreshDefaults)
  }, [])

  useEffect(() => {
    if (groupMode) setGroupDiscussionMode(groupDefaultDiscussionMode)
  }, [groupMode, groupDefaultDiscussionMode])

  useEffect(() => {
    if (!modelMenuOpen && !attachmentMenuOpen && !advancedMenuOpen && !permissionMenuOpen) return
    const onDoc = (e: MouseEvent) => {
      if (!modelMenuRef.current?.contains(e.target as Node)) {
        setModelMenuOpen(null)
        setModelMenuRect(null)
      }
      if (!attachmentMenuRef.current?.contains(e.target as Node)) setAttachmentMenuOpen(false)
      if (!advancedMenuRef.current?.contains(e.target as Node)) setAdvancedMenuOpen(false)
      if (!permissionMenuRef.current?.contains(e.target as Node)) setPermissionMenuOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [modelMenuOpen, attachmentMenuOpen, advancedMenuOpen, permissionMenuOpen])

  const mentionScan = useMemo(() => scanMentions(text), [text])
  const mentions = useMemo(
    () => mentionScan.agents.filter((name) => enabledSet.has(name)),
    [mentionScan, enabledSet],
  )
  const activeGroupAgents = useMemo(
    () => {
      const visible = groupAgents.filter((name) => enabledSet.has(name))
      return visible.length ? visible : enabledAgents
    },
    [groupAgents, enabledAgents, enabledSet],
  )
  const activeGroupSet = useMemo(() => new Set(activeGroupAgents), [activeGroupAgents])
  // @all / @所有人:群聊里展开成本轮参与成员,单聊里展开成所有已启用 agent。
  const groupMentions = useMemo(
    () => (mentionScan.all ? activeGroupAgents : mentions.filter((a) => activeGroupSet.has(a))),
    [mentionScan.all, mentions, activeGroupAgents, activeGroupSet],
  )
  const singleMentions = useMemo(
    () => (mentionScan.all ? enabledAgents : mentions),
    [mentionScan.all, mentions, enabledAgents],
  )
  const serialParticipants = useMemo(
    () => activeGroupAgents.filter((a) => !serialExcluded.has(a)),
    [activeGroupAgents, serialExcluded],
  )
  const autoFirstAgent = groupMentions[0] ?? (activeGroupSet.has(agent) ? agent : activeGroupAgents[0])
  // 首位必须在参与成员里;用户排除了自己选的首位时回落到第一个参与成员。
  const serialFirst =
    serialFirstAgent !== 'auto' && serialParticipants.includes(serialFirstAgent)
      ? serialFirstAgent
      : serialParticipants.includes(autoFirstAgent)
        ? autoFirstAgent
        : serialParticipants[0]
  const firstGroupAgent = groupDiscussionMode === 'serial' ? serialFirst : autoFirstAgent
  const usingNative = !groupMode && mode === 'native' && nativeAvailable
  const targets = groupMode
    ? groupDiscussionMode === 'serial'
      ? [firstGroupAgent]
      : groupMentions
    : usingNative
    ? [sessionAgent]
    : singleMentions.length
    ? singleMentions
    : [agent]
  const usingMentions = !usingNative && singleMentions.length > 0
  const mentionOptions = useMemo((): { value: MentionTarget; label: string }[] => {
    if (!mentionMenu) return []
    const agents = enabledAgentOptions.filter((a) =>
      a.value.toLowerCase().startsWith(mentionMenu.query) && (!groupMode || activeGroupSet.has(a.value)),
    )
    // 全员选项:候选成员多于一个时才有意义,@all / @everyone 都能筛到它。
    const allCandidates = groupMode ? activeGroupAgents : enabledAgents
    const matchesAll = ['all', 'everyone'].some((alias) => alias.startsWith(mentionMenu.query))
    const allOption: { value: MentionTarget; label: string }[] =
      allCandidates.length > 1 && matchesAll
        ? [{ value: 'all', label: t('composer.mentionAllLabel', { count: allCandidates.length }) }]
        : []
    return [...allOption, ...agents]
  }, [mentionMenu, groupMode, activeGroupSet, activeGroupAgents, enabledAgentOptions, enabledAgents, t])

  useEffect(() => {
    let alive = true
    Promise.all(enabledAgents.map(async (name) => {
      try {
        return [name, await fetchAgentCapabilities(name, cwd)] as const
      } catch {
        return null
      }
    }))
      .then((entries) => {
        if (alive) {
          setCliCapabilities(Object.fromEntries(entries.filter((entry) => entry !== null)) as Partial<Record<AgentName, AgentCliCapabilitiesDTO>>)
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [cwd, enabledAgents])

  useEffect(() => {
    setCliByAgent((current) => {
      let changed = false
      const next = { ...current }
      for (const targetAgent of enabledAgents) {
        const capability = cliCapabilities[targetAgent]
        const selected = current[targetAgent]
        if (capability?.effortDetection.status !== 'detected' || !selected?.model || !selected.effort) continue
        const model = capability.models.find((item) => item.value === selected.model)
        if (model && !(model.efforts ?? []).includes(selected.effort)) {
          next[targetAgent] = { ...selected, effort: '' }
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [cliCapabilities, enabledAgents])

  useEffect(() => {
    if ((groupMode || !nativeAvailable) && mode === 'native') setMode('followup')
  }, [nativeAvailable, mode, groupMode])

  useEffect(() => {
    // 离开 native 模式或换 session,写回授权立刻失效。
    if (mode !== 'native') setNativeTrustWrite(false)
  }, [mode])

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
    const preferred = sessionAgent === 'codex' ? 'claude' : 'codex'
    const reviewAgent = enabledSet.has(preferred) ? preferred : enabledAgents[0]
    setMode('followup')
    setAgent(reviewAgent)
    setModelMenuOpen(null)
    setAdvancedMenuOpen(false)
    setReviewDraft(true)
    setText(t('composer.reviewTemplate'))
  }

  const send = () => {
    // 原名 t,与 i18n 的 t 冲突,改名 body。
    const body = text.trim()
    if (!body && attachments.length === 0) return
    const outgoing = attachments.length ? attachments : undefined
    if (usingNative) {
      onNativeSend(body, outgoing, nativeTrustWrite ? 'trusted' : 'read-only')
      // 每次发送后回落到 read-only。native resume 是"跨出 cockpit 沙箱"的动作,
      // 不允许粘性授权 —— 用户下一条要写回必须重新勾选。
      setNativeTrustWrite(false)
    } else {
      // 单 agent 场景按当前 agent 偏好透传;@mentions 多目标下让 caller 走默认,避免一个
      // 模型设置被错配到另一个 agent。
      const options = groupMode ? cliByAgent : !usingMentions ? cliByAgent[agent] : undefined
      // Phase 2 加速模式:targets 中含 codex 且开关开启时透传(单聊、群聊都适用)。
      const extras =
        codexAcceleratedMode && targets.includes('codex')
          ? { codexAcceleratedMode: true }
          : undefined
      onSend(body, targets, options, outgoing, permissionsForMode(permissionMode), {
        ...extras,
        ...(groupMode
          ? {
              groupMode: groupDiscussionMode,
              groupParticipants: activeGroupAgents,
              serial:
                groupDiscussionMode === 'serial'
                  ? {
                      participants: serialParticipants,
                      firstAgent: targets[0],
                      maxSteps: serialMaxSteps,
                      stopOnConsensus: true,
                      preset: serialPreset,
                    }
                  : undefined,
            }
          : {}),
      })
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

  const pickFiles = async () => {
    setAttachmentMenuOpen(false)
    try {
      const paths = await pickLocalPaths('file')
      addPathAttachments('file', paths)
    } catch (err) {
      setAttachmentError((err as Error)?.message === 'native-picker-unavailable' ? t('composer.noNativePicker') : String((err as Error)?.message ?? err))
    }
  }

  const pickDirectory = async () => {
    setAttachmentMenuOpen(false)
    try {
      const paths = await pickLocalPaths('directory')
      addPathAttachments('directory', paths)
    } catch (err) {
      setAttachmentError((err as Error)?.message === 'native-picker-unavailable' ? t('composer.noNativePicker') : String((err as Error)?.message ?? err))
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
    setCliByAgent((current) => {
      const selected = { ...current[targetAgent], [field]: value }
      if (field === 'model') {
        const allowed = cliCapabilities[targetAgent]?.models.find((model) => model.value === value)?.efforts
        if (allowed?.length && selected.effort && !allowed.includes(selected.effort)) selected.effort = ''
      }
      return { ...current, [targetAgent]: selected }
    })
  }

  const toggleGroupAgent = (targetAgent: AgentName) => {
    setGroupAgents((prev) => {
      if (prev.includes(targetAgent)) {
        return prev.length > 1 ? prev.filter((a) => a !== targetAgent) : prev
      }
      return [...prev, targetAgent]
    })
    setAgent(targetAgent)
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

  const pickMention = (picked?: MentionTarget) => {
    if (!mentionMenu || !picked) return
    const el = textareaRef.current
    const caret = el?.selectionStart ?? text.length
    const before = text.slice(0, mentionMenu.start)
    const after = text.slice(caret)
    const insert = `@${picked} `
    const next = `${before}${insert}${after}`
    const nextCaret = before.length + insert.length
    setText(next)
    if (picked !== 'all') setAgent(picked)
    setMentionMenu(null)
    setMentionConfirm(picked)
    if (mentionConfirmTimer.current) window.clearTimeout(mentionConfirmTimer.current)
    mentionConfirmTimer.current = window.setTimeout(() => setMentionConfirm(null), 1400)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(nextCaret, nextCaret)
    })
  }

  const cliGroupsForAgent = (targetAgent: AgentName): CliGroup[] => {
    const base = CLI_GROUPS[targetAgent] ?? []
    const capability = cliCapabilities[targetAgent]
    const detectedModels = capability && ['detected', 'cached'].includes(capability.modelDetection.status)
      ? capability.models
      : []
    const selectedModel = detectedModels.find((model) => model.value === (cliByAgent[targetAgent]?.model ?? ''))
    const detectedEfforts = selectedModel
      ? selectedModel.efforts ?? []
      : targetAgent === 'opencode'
        ? []
        : capability?.effortDetection.values ?? []
    return base.map((group) => {
      if (group.key === 'model' && detectedModels.length) {
        const defaultHintKey: MessageKey =
          targetAgent === 'opencode'
            ? 'cli.openCodeDefault'
            : targetAgent === 'cursor'
              ? 'cli.cursorDefault'
              : 'cli.default'
        return {
          ...group,
          options: [{
            value: '',
            label: 'Default',
            hint: detectedModels.find((model) => model.isDefault)?.label,
            hintKey: detectedModels.some((model) => model.isDefault) ? undefined : defaultHintKey,
          }, ...detectedModels],
        }
      }
      if (group.key === 'effort' && capability?.effortDetection.status === 'detected') {
        return {
          ...group,
          options: [
            { value: '', label: 'Default', hintKey: 'cli.default' },
            ...detectedEfforts.map((value) => ({ value, label: value })),
          ],
        }
      }
      return group
    })
  }

  const groups = cliGroupsForAgent(agent)
  // 按钮 label:把每个 group 的当前选项串成 "GPT-5.5 · 中";全 Default 时显示 "Default"。
  const triggerLabel = (targetAgent: AgentName) => {
    const parts = cliGroupsForAgent(targetAgent).map((g) => {
      const v = cliByAgent[targetAgent]?.[g.key] ?? ''
      const found = g.options.find((o) => o.value === v)
      return found ? optionLabel(found, t) : 'Default'
    })
    return parts.every((p) => p === 'Default') ? 'Default' : parts.join(' · ')
  }

  const triggerParts = (targetAgent: AgentName) => {
    const groups = cliGroupsForAgent(targetAgent)
    const selected = cliByAgent[targetAgent] ?? {}
    const labelFor = (key: CliField) => {
      const group = groups.find((item) => item.key === key)
      if (!group) return null
      const value = selected[key] ?? ''
      const option = group.options.find((item) => item.value === value)
      return option ? optionLabel(option, t) : 'Default'
    }
    return { model: labelFor('model') ?? 'Default', effort: labelFor('effort') }
  }

  const renderModelPicker = (targetAgent: AgentName, withAgent = false, enabled = true) => {
    const targetGroups = cliGroupsForAgent(targetAgent)
    const targetSel = cliByAgent[targetAgent] ?? {}
    const label = triggerLabel(targetAgent)
    const parts = triggerParts(targetAgent)
    const hasCustomSelection = label !== 'Default'
    const isTargeted = groupMode && targets.includes(targetAgent)
    const popoverLeft =
      groupMode && modelMenuRect && typeof window !== 'undefined'
        ? Math.max(
            MODEL_POPOVER_MARGIN,
            Math.min(
              modelMenuRect.left,
              window.innerWidth - MODEL_POPOVER_WIDTH - MODEL_POPOVER_MARGIN,
            ),
          )
        : undefined
    const popoverOpenUp = groupMode && modelMenuRect ? modelMenuRect.top > 300 : false
    const popoverMaxHeight =
      groupMode && modelMenuRect && typeof window !== 'undefined'
        ? Math.max(
            180,
            popoverOpenUp
              ? modelMenuRect.top - 24
              : window.innerHeight - modelMenuRect.bottom - 24,
          )
        : undefined
    return (
      <div
        className={[
          'model-picker',
          withAgent ? `group-model-picker agent-${targetAgent}` : '',
          withAgent && enabled ? 'enabled' : '',
          withAgent && !enabled ? 'disabled' : '',
          withAgent && isTargeted ? 'targeted' : '',
          withAgent && hasCustomSelection ? 'configured' : '',
        ].filter(Boolean).join(' ')}
      >
        <button
          className="model-picker-btn"
          onClick={(e) => {
            if (withAgent && !enabled) {
              toggleGroupAgent(targetAgent)
              return
            }
            const rect = e.currentTarget.getBoundingClientRect()
            setModelMenuRect({ left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width })
            setModelMenuOpen((v) => {
              if (v === targetAgent) {
                setModelMenuRect(null)
                return null
              }
              return targetAgent
            })
          }}
          title={
            withAgent && !enabled
              ? t('composer.enableAgent', { agent: labelForAgent(targetAgent) })
              : t('composer.cliArgsOf', { agent: labelForAgent(targetAgent), detail: hasCustomSelection ? `: ${label}` : '' })
          }
          aria-haspopup="menu"
          aria-expanded={modelMenuOpen === targetAgent}
          aria-pressed={withAgent ? enabled : undefined}
          aria-label={withAgent ? `${labelForAgent(targetAgent)}${enabled ? `: ${label}` : ''}` : undefined}
        >
          {!withAgent && <Icon name="settings" size={12} />}
          {withAgent && <AgentIcon agent={targetAgent} size={18} />}
          {withAgent && enabled && (
            <span className="model-picker-selection">
              <span className="model-picker-model">{parts.model}</span>
              {parts.effort && (
                <span className="model-picker-effort" title={t('cli.reasoning')}>
                  <span className="model-picker-effort-label">{t('cli.reasoning')}</span>
                  <span>{parts.effort}</span>
                </span>
              )}
            </span>
          )}
          {!withAgent && enabled && <span>{label}</span>}
          {enabled && <span className="model-picker-caret">▾</span>}
        </button>
        {withAgent && enabled && (
          <button
            type="button"
            className="group-agent-remove"
            onClick={(e) => {
              e.stopPropagation()
              setModelMenuOpen(null)
              setModelMenuRect(null)
              toggleGroupAgent(targetAgent)
            }}
            title={t('composer.removeFromTurn', { agent: labelForAgent(targetAgent) })}
            aria-label={t('composer.removeAgent', { agent: labelForAgent(targetAgent) })}
          >
            <Icon name="close" size={10} />
          </button>
        )}
        {enabled && modelMenuOpen === targetAgent && (
          <div
            className={`model-popover ${groupMode ? 'fixed-popover' : ''} ${popoverOpenUp ? 'open-up' : ''}`}
            role="menu"
            style={
              groupMode && modelMenuRect && popoverLeft != null
                ? {
                    left: popoverLeft,
                    top: popoverOpenUp ? modelMenuRect.top - 8 : modelMenuRect.bottom + 8,
                    maxHeight: popoverMaxHeight,
                  }
                : undefined
            }
          >
            {targetGroups.map((g, gi) => (
              <div key={g.key} className="model-popover-group">
                {gi > 0 && <div className="model-popover-sep" />}
                <div className="model-popover-title">{t(g.labelKey)}</div>
                {g.options.map((o) => {
                  const active = (targetSel[g.key] ?? '') === o.value
                  return (
                    <button
                      key={o.value || '__default'}
                      className={`model-popover-item ${active ? 'active' : ''}`}
                      onClick={() => pickCli(targetAgent, g.key, o.value)}
                    >
                      <span>{optionLabel(o, t)}</span>
                      {(o.hintKey || o.hint) && (
                        <span className="model-popover-hint">{o.hintKey ? t(o.hintKey) : o.hint}</span>
                      )}
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
  const permissionOption = PERMISSION_OPTIONS.find((o) => o.mode === permissionMode) ?? PERMISSION_OPTIONS[0]

  const sendTitle = usingNative
    ? t('composer.nativeHint', { agent: agentLabel })
    : groupMode && targets.length === 0
    ? t('composer.groupOnlyHint')
    : groupMode && groupDiscussionMode === 'serial'
    ? t('composer.serialHint', { agent: labelForAgent(targets[0]), count: serialMaxSteps })
    : usingMentions
    ? t('composer.parallelHint', { agents: targets.map(labelForAgent).join('、') })
    : t('composer.followupHint', { agent: labelForAgent(agent), permission: t(permissionOption.labelKey) })
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
                  title={t('composer.cockpitFollowupTitle')}
                >
                  <Icon name="arrow-up-right" size={12} />
                  <span>{t('composer.cockpitFollowup')}</span>
                </button>
                <button
                  className={`send-mode-item ${usingNative ? 'active' : ''}`}
                  onClick={() => chooseMode('native')}
                  disabled={!nativeAvailable}
                  title={
                    nativeAvailable
                      ? t('composer.nativeResumeTitle', { agent: agentLabel })
                      : t('composer.nativeResumeUnsupported')
                  }
                >
                  <Icon name="rotate-ccw" size={12} />
                  <span>{t('composer.nativeResume')}</span>
                </button>
                <div id="send-mode-help" className="composer-help-popover" role="tooltip">
                  <div className="composer-help-title">{t('composer.sendModeTitle')}</div>
                  <div>{t('composer.sendModeCockpit')}</div>
                  <div>{t('composer.sendModeNative')}</div>
                </div>
              </div>
            </>
          )}

          {groupMode ? (
            <div className="group-composer-stack">
            <div className="group-composer-controls">
              <div className="send-mode-control" aria-label={t('composer.groupModeLabel')}>
                <button
                  className={`send-mode-item ${groupDiscussionMode === 'parallel' ? 'active' : ''}`}
                  onClick={() => setGroupDiscussionMode('parallel')}
                  title={t('composer.parallelTitle')}
                >
                  <Icon name="users" size={12} />
                  <span>{t('newChat.parallel')}</span>
                </button>
                <button
                  className={`send-mode-item ${groupDiscussionMode === 'serial' ? 'active' : ''}`}
                  onClick={() => setGroupDiscussionMode('serial')}
                  title={t('composer.serialTitle')}
                >
                  <Icon name="chevron-right" size={12} />
                  <span>{t('newChat.serial')}</span>
                </button>
              </div>
              {groupDiscussionMode === 'serial' && (
                <>
                  <label className="serial-step-control" title={t('composer.serialStepsTitle')}>
                    <span>{t('composer.atMost')}</span>
                    <input
                      type="number"
                      min={2}
                      max={20}
                      value={serialMaxSteps}
                      onChange={(e) => setSerialMaxSteps(Math.max(2, Math.min(Number(e.target.value) || 6, 20)))}
                    />
                    <span>{t('composer.turnsUnit')}</span>
                  </label>
                </>
              )}
              <div className="group-model-settings" ref={modelMenuRef}>
                {enabledAgentOptions.map((a) => (
                  <div key={a.value}>{renderModelPicker(a.value, true, activeGroupSet.has(a.value))}</div>
                ))}
              </div>
            </div>
            {groupDiscussionMode === 'serial' && (
                <div className="serial-controls">
                  <span className="serial-control-label">{t('serial.preset')}</span>
                  <div className="serial-control-row" role="group" aria-label={t('serial.preset')}>
                    {SERIAL_PRESETS.map((p) => (
                      <button
                        key={p.value}
                        type="button"
                        className={`serial-chip ${serialPreset === p.value ? 'active' : ''}`}
                        onClick={() => setSerialPreset(p.value)}
                        aria-pressed={serialPreset === p.value}
                        title={t(p.hintKey)}
                      >
                        {t(p.labelKey)}
                      </button>
                    ))}
                  </div>
                  <span className="serial-control-label">{t('serial.firstAgent')}</span>
                  <div className="serial-control-row" role="group" aria-label={t('serial.firstAgent')}>
                    <button
                      type="button"
                      className={`serial-chip ${serialFirstAgent === 'auto' ? 'active' : ''}`}
                      onClick={() => setSerialFirstAgent('auto')}
                      aria-pressed={serialFirstAgent === 'auto'}
                      title={t('serial.firstAgentAutoHint')}
                    >
                      {t('serial.firstAgentAuto')}
                    </button>
                    {serialParticipants.map((a) => (
                      <button
                        key={a}
                        type="button"
                        className={`serial-chip ${serialFirstAgent === a ? 'active' : ''}`}
                        onClick={() => setSerialFirstAgent(a)}
                        aria-pressed={serialFirstAgent === a}
                      >
                        <AgentIcon agent={a} size={12} /> {labelForAgent(a)}
                      </button>
                    ))}
                  </div>
                  <span className="serial-control-label">{t('serial.participants')}</span>
                  <div className="serial-control-row" role="group" aria-label={t('serial.participants')}>
                    {activeGroupAgents.map((a) => {
                      const on = !serialExcluded.has(a)
                      // 至少留一个成员,否则没人能发言。
                      const canToggleOff = on && serialParticipants.length > 1
                      return (
                        <button
                          key={a}
                          type="button"
                          className={`serial-chip ${on ? 'active' : ''}`}
                          disabled={on && !canToggleOff}
                          aria-pressed={on}
                          title={t('serial.participantHint', { agent: labelForAgent(a) })}
                          onClick={() =>
                            setSerialExcluded((prev) => {
                              const next = new Set(prev)
                              if (next.has(a)) next.delete(a)
                              else next.add(a)
                              return next
                            })
                          }
                        >
                          <AgentIcon agent={a} size={12} /> {labelForAgent(a)}
                        </button>
                      )
                    })}
                  </div>
                </div>
            )}
            </div>
          ) : usingNative ? (
            <span className={`native-agent-pill agent-${sessionAgent}`}>
              <AgentIcon agent={sessionAgent} size={20} /> {agentLabel}
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
          <div className="attachment-tray" aria-label={t('composer.attachments')}>
            {attachments.map((a, index) => (
              <span key={`${a.kind}-${index}-${a.name}`} className={`attachment-chip ${a.kind === 'imageData' ? 'has-preview' : ''}`}>
                {a.kind === 'imageData' ? (
                  <img className="attachment-chip-preview" src={a.dataUrl} alt={a.name} />
                ) : (
                  <Icon name={a.kind === 'directory' ? 'folder' : 'file-text'} size={12} />
                )}
                <span>{a.name}</span>
                <button onClick={() => removeAttachment(index)} title={t('composer.removeAttachment')} aria-label={t('composer.removeAttachment')}>
                  <Icon name="close" size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
        {attachmentError && <div className="attachment-error">{attachmentError}</div>}
        <div className="composer-textarea-shell">
        {/* 高亮背板:与 textarea 共用 .composer-input 的盒模型,只画 mention 底色,文字保持透明。 */}
        <div className="composer-input composer-highlight" ref={highlightRef} aria-hidden="true">
          {mentionSegments.map((seg, index) =>
            seg.target ? (
              <span
                key={index}
                className={`composer-highlight-mention ${seg.target === 'all' ? 'mention-all' : `agent-${seg.target}`}`}
              >
                {seg.text}
              </span>
            ) : (
              <span key={index}>{seg.text}</span>
            ),
          )}
          {'\n'}
        </div>
        <textarea
          ref={textareaRef}
          className="composer-input"
          onScroll={(e) => {
            if (highlightRef.current) highlightRef.current.scrollTop = e.currentTarget.scrollTop
          }}
          placeholder={
            groupMode
              ? t('composer.groupPlaceholder')
              : usingNative
              ? t('composer.nativePlaceholder', { agent: agentLabel })
              : t('composer.followupPlaceholder')
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
        </div>
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
                {a.value === 'all' ? <Icon name="users" size={16} /> : <AgentIcon agent={a.value} size={16} />}
                <span>@{a.value}</span>
                <span className="mention-menu-label">{a.label}</span>
              </button>
            ))}
          </div>
        )}
        {mentionConfirm && (
          <div className={`mention-confirm ${mentionConfirm === 'all' ? 'mention-all' : `agent-${mentionConfirm}`}`} aria-live="polite">
            {mentionConfirm === 'all' ? <Icon name="users" size={15} /> : <AgentIcon agent={mentionConfirm} size={15} />}
            <span>{t('composer.mentionAdded', { agent: mentionConfirm })}</span>
          </div>
        )}
        <div className="composer-action-bar">
          <div className="composer-action-left">
            {!hasActiveStreams && (
              <div className="attachment-menu-wrap" ref={attachmentMenuRef}>
                <button
                  className="composer-attach-btn"
                  onClick={() => setAttachmentMenuOpen((v) => !v)}
                  title={t('composer.addAttachment')}
                  aria-label={t('composer.addAttachment')}
                  aria-expanded={attachmentMenuOpen}
                >
                  <Icon name="paperclip" size={16} />
                </button>
                {attachmentMenuOpen && (
                  <div className="attachment-menu">
                    <button onMouseDown={(e) => e.preventDefault()} onClick={pickFiles}>
                      <Icon name="file-text" size={13} />
                      <span>{t('composer.file')}</span>
                    </button>
                    <button onMouseDown={(e) => e.preventDefault()} onClick={pickDirectory}>
                      <Icon name="folder" size={13} />
                      <span>{t('composer.folder')}</span>
                    </button>
                  </div>
                )}
              </div>
            )}
            {!hasActiveStreams && usingNative && (
              <button
                type="button"
                className={`native-write-toggle ${nativeTrustWrite ? 'active' : ''}`}
                onClick={() => setNativeTrustWrite((v) => !v)}
                title={
                  nativeTrustWrite
                    ? t('composer.nativeTrustOn')
                    : t('composer.nativeTrustOff')
                }
                aria-pressed={nativeTrustWrite}
              >
                <Icon name={nativeTrustWrite ? 'alert-triangle' : 'lock'} size={13} />
                <span>{nativeTrustWrite ? t('composer.trustWriteOnce') : t('composer.readOnlyPreview')}</span>
              </button>
            )}
            {!hasActiveStreams && !usingNative && (
              <div className="permission-menu-wrap" ref={permissionMenuRef}>
                <button
                  className={`permission-trigger permission-${permissionMode}`}
                  onClick={() => setPermissionMenuOpen((v) => !v)}
                  title={t('composer.permissionOf', { permission: t(permissionOption.labelKey) })}
                  aria-label={t('composer.permissionSettings')}
                  aria-expanded={permissionMenuOpen}
                >
                  <Icon name="wrench" size={14} />
                  <span>{t(permissionOption.labelKey)}</span>
                </button>
                {permissionMenuOpen && (
                  <div className="permission-menu" role="menu">
                    <div className="permission-menu-title">{t('composer.permissionMenuTitle')}</div>
                    {PERMISSION_OPTIONS.map((option) => {
                      const active = option.mode === permissionMode
                      return (
                        <button
                          key={option.mode}
                          className={`permission-menu-item ${active ? 'active' : ''}`}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            setPermissionMode(option.mode)
                            setPermissionMenuOpen(false)
                          }}
                        >
                          <span className="permission-menu-copy">
                            <strong>{t(option.labelKey)}</strong>
                            <span>{t(option.hintKey)}</span>
                          </span>
                          {active && <Icon name="check" size={13} />}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
            {!hasActiveStreams && !usingNative && (
              <div className="advanced-menu-wrap" ref={advancedMenuRef}>
                <button
                  className="composer-attach-btn"
                  onClick={() => setAdvancedMenuOpen((v) => !v)}
                  title={t('composer.advanced')}
                  aria-label={t('composer.advanced')}
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
                    {(agent === 'codex' || targets.includes('codex')) && onCodexAcceleratedModeChange && (
                      <button
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          const next = !codexAcceleratedMode
                          if (next) {
                            const ok = window.confirm(
                              t('composer.codexAccelConfirm'),
                            )
                            if (!ok) return
                          }
                          onCodexAcceleratedModeChange(next)
                        }}
                        title={
                          codexAcceleratedMode
                            ? t('composer.codexAccelOn')
                            : t('composer.codexAccelOff')
                        }
                      >
                        <Icon name="sparkle" size={13} />
                        <span>{codexAcceleratedMode ? t('composer.codexAccelActive') : t('composer.codexAccel')}</span>
                      </button>
                    )}
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
              title={hasActiveStreams ? t('composer.cancelAllTitle') : t('composer.sendTitleSuffix', { title: sendTitle })}
              aria-label={hasActiveStreams ? t('composer.cancelGenerating') : t('composer.send')}
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
