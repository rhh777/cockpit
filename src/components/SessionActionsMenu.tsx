import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from './Icon'
import {
  createHandoff,
  fetchHandoff,
  groupFromSession,
  openNativeHandoff,
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

type BusyKind = 'to-group' | 'codex' | 'claude' | 'handoff' | null

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

export function SessionActionsMenu({ source, sessionId, isGroup, cwd }: Props) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<BusyKind>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<HandoffResult | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const runAction = useCallback(
    async (kind: Exclude<BusyKind, null>) => {
      setError(null)
      setBusy(kind)
      setOpen(false)
      try {
        if (kind === 'to-group') {
          if (isGroup) throw new Error('已经是群聊')
          const { groupThreadId } = await groupFromSession({ source, sessionId })
          navigate(`/cockpit/${encodeURIComponent(groupThreadId)}`)
          return
        }
        const ref = sourceRefFor(source, sessionId, isGroup)
        if (kind === 'handoff') {
          const manifest = await createHandoff({ source: ref, target: 'both' })
          setResult({ manifest })
          return
        }
        const provider = kind === 'codex' ? 'codex' : 'claude'
        const manifest = await createHandoff({ source: ref, target: provider })
        const opened = await openNativeHandoff(manifest.handoffId, { provider })
        setResult({ manifest, provider, nativeLink: opened.nativeLink, fallbackPrompt: opened.fallbackPrompt })
        if (provider === 'codex' && opened.nativeLink.url && opened.nativeLink.status === 'created') {
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

  const groupLabel = isGroup ? '已是群聊' : '转为群聊'

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
          <button role="menuitem" disabled={isGroup} onClick={() => runAction('to-group')}>
            {groupLabel}
          </button>
          <button role="menuitem" onClick={() => runAction('codex')}>
            和 Codex 继续
          </button>
          <button role="menuitem" onClick={() => runAction('claude')}>
            和 Claude 继续
          </button>
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
              <button className="modal-btn" onClick={reveal}>在 Finder 中打开</button>
            </div>
          </div>
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

          {result.provider === 'codex' && deeplinkUrl && !overBudget && (
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
