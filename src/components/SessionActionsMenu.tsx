import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from './Icon'
import { nativeAgentForSource } from '../lib/agents'
import { useI18n } from '../lib/i18n'
import {
  createHandoff,
  createReviewRoom,
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

type BusyKind = 'to-group' | 'review-room' | 'codex' | 'codex-app-server' | 'claude' | 'handoff' | null

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

export function SessionActionsMenu({ source, sessionId, isGroup, cwd }: Props) {
  const navigate = useNavigate()
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<BusyKind>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<HandoffResult | null>(null)
  const [groupChooserOpen, setGroupChooserOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const currentNativeAgent = isGroup ? null : nativeAgentForSource(source)
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
          if (isGroup) throw new Error(t('actions.alreadyGroup'))
          const scope = opts?.groupScope ?? 'all'
          const includeRecentEvents = scope === 'all' ? 'all' : scope * 2
          const { groupThreadId } = await groupFromSession({ source, sessionId, includeRecentEvents })
          navigate(`/cockpit/${encodeURIComponent(groupThreadId)}`)
          return
        }
        if (kind === 'review-room') {
          const ref = sourceRefFor(source, sessionId, isGroup)
          const reviewSource = ref.kind === 'group-thread'
            ? { kind: 'group-thread' as const, groupThreadId: ref.groupThreadId ?? sessionId }
            : {
                kind: ref.kind as 'native-session' | 'cockpit-followup',
                source,
                sessionId,
              }
          const created = await createReviewRoom({
            source: reviewSource,
            goal: t('actions.reviewRoomGoal'),
            participants: ['claude', 'codex'],
            startReview: true,
          })
          if (created.startError) setError(t('actions.reviewRoomStartFailed', { error: created.startError }))
          navigate(`/cockpit/${encodeURIComponent(created.groupThreadId)}`)
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
        title={t('actions.more')}
        aria-label={t('actions.more')}
      >
        <Icon name="more-horizontal" size={13} />
      </button>
      {open && (
        <div className="session-actions-menu" role="menu">
          <button role="menuitem" onClick={() => runAction('review-room')}>
            {t('actions.createReviewRoom')}
          </button>
          <button
            role="menuitem"
            disabled={isGroup}
            onClick={() => {
              setOpen(false)
              setGroupChooserOpen(true)
            }}
          >
            {isGroup ? t('actions.alreadyGroup') : t('actions.toGroup')}
          </button>
          {showCodexContinue && (
            <>
              <button role="menuitem" onClick={() => runAction('codex')}>
                {t('actions.continueCodex')}
              </button>
              <button role="menuitem" onClick={() => runAction('codex-app-server')}>
                {t('actions.continueCodexDeep')}
              </button>
            </>
          )}
          {showClaudeContinue && (
            <button role="menuitem" onClick={() => runAction('claude')}>
              {t('actions.continueClaude')}
            </button>
          )}
          <button role="menuitem" onClick={() => runAction('handoff')}>
            {t('actions.createHandoff')}
          </button>
        </div>
      )}
      {busy && <span className="session-actions-busy">{t('actions.busy')}</span>}
      {error && (
        <div className="banner warn session-actions-banner" role="alert">
          {error}
          <button className="banner-close" onClick={() => setError(null)} aria-label={t('common.close')}>
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
  const { t } = useI18n()
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
          <span className="modal-title">{t('group.convertTitle')}</span>
          <button className="modal-close" onClick={onCancel} aria-label={t('common.close')}>×</button>
        </div>
        <div className="modal-body">
          <p className="modal-hint">
            {t('group.convertHint')}
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
            <span>{t('group.allMessages')}</span>
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
            <span>{t('group.recent')}</span>
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
            <span>{t('group.turnsSuffix')}</span>
          </label>
          <div className="modal-actions">
            <button className="modal-btn" onClick={onCancel}>{t('common.cancel')}</button>
            <button className="modal-btn primary" onClick={submit}>{t('common.confirm')}</button>
          </div>
        </div>
      </div>
    </div>
  )
}

function NativeLinkRow({ handoffId, link }: { handoffId: string; link: NativeLinkDTO }) {
  const { t } = useI18n()
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
          {t('handoff.open')}
        </a>
      )}
      {canMirror && (
        <button className="modal-btn" onClick={runMirror} disabled={busy}>
          {busy ? t('handoff.syncing') : level === 'mirrored' ? t('handoff.resync') : t('handoff.sync')}
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
  const { t } = useI18n()
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
  const title =
    result.provider === 'codex'
      ? t('actions.continueCodex')
      : result.provider === 'claude'
      ? t('actions.continueClaude')
      : t('actions.createHandoff')

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
          <button className="modal-close" onClick={onClose} aria-label={t('common.close')}>×</button>
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
                {freshness?.status ?? t('handoff.notChecked')}
              </span>
              {freshness?.reason && <span className="modal-hint">{freshness.reason}</span>}
              <button className="modal-btn" onClick={checkFreshness} disabled={checking}>
                {checking ? t('handoff.checking') : t('handoff.recheck')}
              </button>
              <button className="modal-btn" onClick={doRefresh} disabled={refreshing}>
                {refreshing ? t('handoff.refreshing') : t('handoff.refresh')}
              </button>
              <button className="modal-btn" onClick={reveal}>{t('handoff.revealFinder')}</button>
            </div>
          </div>
          {refreshedTo && (
            <div className="modal-hint">
              {t('handoff.newHandoff')}<code>{refreshedTo}</code>{t('handoff.newHandoffKept')}
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
                {t('handoff.appServerCreated')}
              </p>
              <div className="modal-actions">
                {result.nativeLink.url && (
                  <a className="modal-btn primary" href={result.nativeLink.url}>{t('handoff.openInCodexDesktop')}</a>
                )}
                {result.nativeLink.url && (
                  <button className="modal-btn" onClick={() => copy(result.nativeLink!.url!)}>{t('handoff.copyUrl')}</button>
                )}
              </div>
            </div>
          )}

          {result.provider === 'codex' && deeplinkUrl && result.nativeLink?.method === 'deeplink' && !overBudget && (
            <div className="modal-section">
              <p className="modal-hint">{t('handoff.deeplinkTried')}</p>
              <div className="modal-actions">
                <a className="modal-btn primary" href={deeplinkUrl}>{t('handoff.openCodex')}</a>
                <button className="modal-btn" onClick={() => copy(deeplinkUrl)}>{t('handoff.copyUrl')}</button>
              </div>
            </div>
          )}

          {result.provider === 'codex' && overBudget && (
            <div className="modal-section">
              <p className="modal-hint">{t('handoff.overBudget')}</p>
              <textarea className="modal-textarea" readOnly value={promptText} />
              <div className="modal-actions">
                <button className="modal-btn primary" onClick={() => copy(promptText)}>
                  {copied ? t('handoff.copied') : t('handoff.copyPrompt')}
                </button>
              </div>
            </div>
          )}

          {result.provider === 'claude' && (
            <div className="modal-section">
              <p className="modal-hint">{t('handoff.claudeManual')}</p>
              <textarea className="modal-textarea" readOnly value={promptText} />
              <div className="modal-actions">
                <button className="modal-btn primary" onClick={() => copy(promptText)}>
                  {copied ? t('handoff.copied') : t('handoff.copyPrompt')}
                </button>
              </div>
            </div>
          )}

          {!result.provider && (
            <div className="modal-section">
              <p className="modal-hint">{t('handoff.readyHint')}</p>
              <div className="modal-actions">
                <button className="modal-btn" onClick={() => copy(manifest.files.entries.codex)}>
                  {t('handoff.copyCodexEntry')}
                </button>
                <button className="modal-btn" onClick={() => copy(manifest.files.entries.claude)}>
                  {t('handoff.copyClaudeEntry')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
