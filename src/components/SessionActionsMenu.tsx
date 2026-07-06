import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from './Icon'
import {
  createHandoff,
  fetchHandoff,
  groupFromSession,
  mirrorNativeLink,
  openNativeHandoff,
  refreshHandoff,
  revealHandoff,
  type HandoffDetailDTO,
  type HandoffManifestDTO,
  type HandoffSourceRefDTO,
  type NativeLinkDTO,
} from '../lib/api'

interface Props {
  source: string
  sessionId: string
  isGroup: boolean
  cwd?: string | null
}

type BusyKind = 'to-group' | 'codex' | 'codex-app-server' | 'claude' | 'handoff' | null

type GroupScope = 'all' | number

interface HandoffResult {
  manifest: HandoffManifestDTO
  provider?: 'codex' | 'claude'
  nativeLink?: NativeLinkDTO
  fallbackPrompt?: string
}

function sourceRefFor(source: string, sessionId: string, isGroup: boolean): HandoffSourceRefDTO {
  if (isGroup) return { kind: 'group-thread', groupThreadId: sessionId }
  if (source === 'cockpit') return { kind: 'cockpit-followup', source, sessionId }
  return { kind: 'native-session', source, sessionId }
}

function sessionAgentOf(source: string): 'codex' | 'claude' | null {
  if (source === 'codex') return 'codex'
  if (source === 'claude-code') return 'claude'
  return null
}

export function SessionActionsMenu({ source, sessionId, isGroup, cwd }: Props) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<BusyKind>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<HandoffResult | null>(null)
  const [groupChooserOpen, setGroupChooserOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const currentNativeAgent = isGroup ? null : sessionAgentOf(source)
  const showCodexContinue = currentNativeAgent !== 'codex'
  const showClaudeContinue = currentNativeAgent !== 'claude'

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const runAction = useCallback(
    async (kind: Exclude<BusyKind, null>, opts?: { groupScope?: GroupScope }) => {
      setError(null)
      setBusy(kind)
      setOpen(false)
      try {
        if (kind === 'to-group') {
          if (isGroup) throw new Error('已经是群聊')
          const scope = opts?.groupScope ?? 'all'
          const includeRecentEvents = scope === 'all' ? 'all' : scope * 2
          const { groupThreadId } = await groupFromSession({ source, sessionId, includeRecentEvents })
          navigate(`/cockpit/${encodeURIComponent(groupThreadId)}`)
          return
        }
        const ref = sourceRefFor(source, sessionId, isGroup)
        if (kind === 'handoff') {
          const manifest = await createHandoff({ source: ref, target: 'both' })
          setResult({ manifest })
          return
        }
        const provider: 'codex' | 'claude' = kind === 'claude' ? 'claude' : 'codex'
        const method = kind === 'codex-app-server' ? 'app-server' : undefined
        const manifest = await createHandoff({ source: ref, target: provider })
        const opened = await openNativeHandoff(manifest.handoffId, { provider, method })
        setResult({ manifest, provider, nativeLink: opened.nativeLink, fallbackPrompt: opened.fallbackPrompt })
        // 只有 deeplink 才自动打开;app-server linked 让用户选是否打开 codex://threads/<id>。
        if (
          provider === 'codex' &&
          opened.nativeLink.method === 'deeplink' &&
          opened.nativeLink.url &&
          opened.nativeLink.status === 'created'
        ) {
          window.location.href = opened.nativeLink.url
        }
      } catch (e) {
        setError(String((e as Error)?.message ?? e))
      } finally {
        setBusy(null)
      }
    },
    [source, sessionId, isGroup, navigate],
  )

  return (
    <div className="session-actions-wrap" ref={menuRef}>
      <button
        className="head-icon-btn"
        onClick={() => setOpen((v) => !v)}
        disabled={busy != null}
        title="更多动作"
        aria-label="更多动作"
      >
        <Icon name="more-horizontal" size={13} />
      </button>
      {open && (
        <div className="session-actions-menu" role="menu">
          <button
            role="menuitem"
            disabled={isGroup}
            onClick={() => {
              setOpen(false)
              setGroupChooserOpen(true)
            }}
          >
            {isGroup ? '已是群聊' : '转为群聊…'}
          </button>
          {showCodexContinue && (
            <>
              <button role="menuitem" onClick={() => runAction('codex')}>
                和 Codex 继续
              </button>
              <button role="menuitem" onClick={() => runAction('codex-app-server')}>
                和 Codex 继续(深集成)
              </button>
            </>
          )}
          {showClaudeContinue && (
            <button role="menuitem" onClick={() => runAction('claude')}>
              和 Claude 继续
            </button>
          )}
          <button role="menuitem" onClick={() => runAction('handoff')}>
            生成 Handoff
          </button>
        </div>
      )}
      {busy && <span className="session-actions-busy">处理中…</span>}
      {error && (
        <div className="banner warn session-actions-banner" role="alert">
          {error}
          <button className="banner-close" onClick={() => setError(null)} aria-label="关闭">
            ×
          </button>
        </div>
      )}
      {result && (
        <HandoffResultDialog
          result={result}
          cwd={cwd}
          onClose={() => setResult(null)}
        />
      )}
      {groupChooserOpen && (
        <GroupChooserDialog
          onCancel={() => setGroupChooserOpen(false)}
          onConfirm={(scope) => {
            setGroupChooserOpen(false)
            void runAction('to-group', { groupScope: scope })
          }}
        />
      )}
    </div>
  )
}

function GroupChooserDialog({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void
  onConfirm: (scope: GroupScope) => void
}) {
  const [mode, setMode] = useState<'all' | 'recent'>('all')
  const [turns, setTurns] = useState(10)

  const submit = () => {
    if (mode === 'all') return onConfirm('all')
    const n = Math.max(1, Math.min(Math.floor(turns) || 1, 2000))
    onConfirm(n)
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">转为群聊</span>
          <button className="modal-close" onClick={onCancel} aria-label="关闭">×</button>
        </div>
        <div className="modal-body">
          <p className="modal-hint">
            将本会话导入新群聊。只带 user / assistant 文本消息,不搬 tool_call / tool_result(工具事件绑定具体 agent,跨 agent 会被误读)。要完整 trace 请用「生成 Handoff」。
          </p>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            <input
              type="radio"
              name="group-scope"
              checked={mode === 'all'}
              onChange={() => setMode('all')}
            />
            <span>全部对话(推荐)</span>
          </label>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            <input
              type="radio"
              name="group-scope"
              checked={mode === 'recent'}
              onChange={() => setMode('recent')}
            />
            <span>最近</span>
            <input
              type="number"
              min={1}
              max={2000}
              value={turns}
              onChange={(e) => {
                setMode('recent')
                setTurns(Number(e.target.value))
              }}
              onFocus={() => setMode('recent')}
              style={{
                width: 72,
                height: 26,
                padding: '0 6px',
                borderRadius: 6,
                border: '0.5px solid var(--color-border)',
                background: 'var(--color-background-secondary)',
                color: 'var(--color-text-primary)',
                fontSize: 12,
              }}
            />
            <span>轮对话</span>
          </label>
          <div className="modal-actions">
            <button className="modal-btn" onClick={onCancel}>取消</button>
            <button className="modal-btn primary" onClick={submit}>确定</button>
          </div>
        </div>
      </div>
    </div>
  )
}

function NativeLinkRow({ handoffId, link }: { handoffId: string; link: NativeLinkDTO }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [level, setLevel] = useState(link.linkLevel)
  const canMirror = link.provider === 'codex' && link.method === 'app-server' && !!link.nativeThreadId
  const runMirror = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await mirrorNativeLink(handoffId, link.id)
      setLevel(r.linkLevel)
      setMsg(r.ok ? `mirrored · ${r.itemCount ?? 0} items` : `mirror failed: ${r.error ?? 'unknown'}`)
    } catch (e) {
      setMsg(String((e as Error)?.message ?? e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, flexWrap: 'wrap' }}>
      <span className={`freshness-badge freshness-${link.status === 'failed' ? 'stale' : 'fresh'}`}>
        {link.provider}/{link.method}/{level}
      </span>
      {link.nativeThreadId && <code className="modal-value">{link.nativeThreadId}</code>}
      {link.url && (
        <a className="modal-btn" href={link.url}>
          打开
        </a>
      )}
      {canMirror && (
        <button className="modal-btn" onClick={runMirror} disabled={busy}>
          {busy ? '同步中…' : level === 'mirrored' ? '重新同步' : '同步 (Phase 4)'}
        </button>
      )}
      {msg && <span className="modal-hint">{msg}</span>}
    </div>
  )
}

function HandoffResultDialog({
  result,
  cwd,
  onClose,
}: {
  result: HandoffResult
  cwd?: string | null
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)
  const [freshness, setFreshness] = useState<HandoffDetailDTO['freshness'] | null>(null)
  const [checking, setChecking] = useState(false)
  const [revealError, setRevealError] = useState<string | null>(null)

  const checkFreshness = useCallback(async () => {
    setChecking(true)
    try {
      const detail = await fetchHandoff(result.manifest.handoffId)
      setFreshness(detail.freshness)
    } catch (e) {
      setFreshness({ status: 'unknown', reason: String((e as Error)?.message ?? e) })
    } finally {
      setChecking(false)
    }
  }, [result.manifest.handoffId])

  const reveal = async () => {
    setRevealError(null)
    try {
      await revealHandoff(result.manifest.handoffId)
    } catch (e) {
      setRevealError(String((e as Error)?.message ?? e))
    }
  }
  const [refreshing, setRefreshing] = useState(false)
  const [refreshedTo, setRefreshedTo] = useState<string | null>(null)
  const doRefresh = async () => {
    setRefreshing(true)
    try {
      const next = await refreshHandoff(result.manifest.handoffId)
      setRefreshedTo(next.handoffId)
      setFreshness({ status: 'fresh' })
    } catch (e) {
      setRevealError(String((e as Error)?.message ?? e))
    } finally {
      setRefreshing(false)
    }
  }
  const promptText = result.fallbackPrompt ?? ''
  const overBudget = result.nativeLink?.status === 'failed'
  const deeplinkUrl = result.nativeLink?.provider === 'codex' ? result.nativeLink.url : undefined
  const manifest = result.manifest
  const title = result.provider === 'codex' ? '和 Codex 继续' : result.provider === 'claude' ? '和 Claude 继续' : '生成 Handoff'

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">{title}</span>
          <button className="modal-close" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="modal-body">
          <div className="modal-row">
            <span className="modal-label">Handoff ID</span>
            <code className="modal-value">{manifest.handoffId}</code>
          </div>
          <div className="modal-row">
            <span className="modal-label">Freshness</span>
            <div className="modal-freshness">
              <span className={`freshness-badge freshness-${freshness?.status ?? 'unset'}`}>
                {freshness?.status ?? '未检查'}
              </span>
              {freshness?.reason && <span className="modal-hint">{freshness.reason}</span>}
              <button className="modal-btn" onClick={checkFreshness} disabled={checking}>
                {checking ? '检查中…' : '重新检查'}
              </button>
              <button className="modal-btn" onClick={doRefresh} disabled={refreshing}>
                {refreshing ? '刷新中…' : '刷新 Handoff'}
              </button>
              <button className="modal-btn" onClick={reveal}>在 Finder 中打开</button>
            </div>
          </div>
          {refreshedTo && (
            <div className="modal-hint">
              新 Handoff:<code>{refreshedTo}</code>(旧 handoff / native link 保留)
            </div>
          )}
          {manifest.stats && (
            <div className="modal-row">
              <span className="modal-label">Bundle</span>
              <span className="modal-value">
                {manifest.stats.eventsIncluded}/{manifest.stats.eventsTotal} events
                {manifest.stats.transcriptTruncated ? ` · truncated (${manifest.stats.transcriptMode})` : ''} · ~
                {manifest.stats.approxTokens.toLocaleString()} tokens
              </span>
            </div>
          )}
          {manifest.nativeLinks.length > 0 && (
            <div className="modal-row">
              <span className="modal-label">Native links</span>
              <div className="modal-freshness" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                {manifest.nativeLinks.map((nl) => (
                  <NativeLinkRow key={nl.id} handoffId={manifest.handoffId} link={nl} />
                ))}
              </div>
            </div>
          )}
          {revealError && <div className="modal-hint">{revealError}</div>}
          {cwd && (
            <div className="modal-row">
              <span className="modal-label">Workspace</span>
              <code className="modal-value">{cwd}</code>
            </div>
          )}
          <div className="modal-row">
            <span className="modal-label">Entry</span>
            <code className="modal-value">
              {result.provider === 'claude'
                ? manifest.files.entries.claude
                : manifest.files.entries.codex}
            </code>
          </div>

          {result.provider === 'codex' && result.nativeLink?.method === 'app-server' && result.nativeLink.nativeThreadId && (
            <div className="modal-section">
              <div className="modal-row">
                <span className="modal-label">Thread ID</span>
                <code className="modal-value">{result.nativeLink.nativeThreadId}</code>
              </div>
              <p className="modal-hint">
                已通过 codex app-server 创建 thread 并发送 handoff prompt。Cockpit 将在后台流式接收本轮事件。
              </p>
              <div className="modal-actions">
                {result.nativeLink.url && (
                  <a className="modal-btn primary" href={result.nativeLink.url}>在 Codex Desktop 打开</a>
                )}
                {result.nativeLink.url && (
                  <button className="modal-btn" onClick={() => copy(result.nativeLink!.url!)}>复制 URL</button>
                )}
              </div>
            </div>
          )}

          {result.provider === 'codex' && deeplinkUrl && result.nativeLink?.method === 'deeplink' && !overBudget && (
            <div className="modal-section">
              <p className="modal-hint">已尝试在 Codex Desktop 中打开新会话。若未响应,可手动打开:</p>
              <div className="modal-actions">
                <a className="modal-btn primary" href={deeplinkUrl}>打开 Codex</a>
                <button className="modal-btn" onClick={() => copy(deeplinkUrl)}>复制 URL</button>
              </div>
            </div>
          )}

          {result.provider === 'codex' && overBudget && (
            <div className="modal-section">
              <p className="modal-hint">Prompt 超过 deeplink 长度限制。请复制下面 prompt 手动发起:</p>
              <textarea className="modal-textarea" readOnly value={promptText} />
              <div className="modal-actions">
                <button className="modal-btn primary" onClick={() => copy(promptText)}>
                  {copied ? '已复制' : '复制 Prompt'}
                </button>
              </div>
            </div>
          )}

          {result.provider === 'claude' && (
            <div className="modal-section">
              <p className="modal-hint">Claude 端默认走手动 prompt。复制发送即可:</p>
              <textarea className="modal-textarea" readOnly value={promptText} />
              <div className="modal-actions">
                <button className="modal-btn primary" onClick={() => copy(promptText)}>
                  {copied ? '已复制' : '复制 Prompt'}
                </button>
              </div>
            </div>
          )}

          {!result.provider && (
            <div className="modal-section">
              <p className="modal-hint">Handoff 已生成。可继续发起 Codex / Claude 或直接打开目录。</p>
              <div className="modal-actions">
                <button className="modal-btn" onClick={() => copy(manifest.files.entries.codex)}>
                  复制 Codex Entry 路径
                </button>
                <button className="modal-btn" onClick={() => copy(manifest.files.entries.claude)}>
                  复制 Claude Entry 路径
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
