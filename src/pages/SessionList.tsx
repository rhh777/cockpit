import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react'
import { Link, useMatch, useNavigate } from 'react-router-dom'
import {
  createGroupThread,
  createReviewRoom,
  deleteGroupThread,
  fetchRunningRuns,
  fetchSessions,
  renameGroupThread,
  type ActiveRunDTO,
  type CreateReviewRoomBody,
  type SessionSummaryDTO,
} from '../lib/api'
import { displayTitle, localizeReviewRoomTitle, relativeTime } from '../lib/display'
import { AgentIcon } from '../components/AgentIcon'
import { AGENT_OPTIONS, labelForAgent } from '../lib/agents'
import { Icon } from '../components/Icon'
import { useI18n, type MessageKey, type ResolvedLocale } from '../lib/i18n'
import type { AgentName } from '../lib/types'
import { pickLocalPaths } from '../lib/native-dialog'
import { useEnabledAgentOptions } from '../hooks/useEnabledAgents'

type ViewMode = 'all' | 'cockpit' | AgentName
type GroupMode = 'project' | 'time'

const PINNED_SESSIONS_KEY = 'cockpit.pinnedSessions'
const GROUP_MODE_KEY = 'cockpit.sessionGroupMode'
const MAX_COLLAPSED_ITEMS = 5
const RECENT_SESSION_LIMIT = 5
const DAY_MS = 24 * 60 * 60 * 1000
const ACTIVE_RUN_POLL_MS = 2000

function sessionKey(s: Pick<SessionSummaryDTO, 'source' | 'id'>): string {
  return `${s.source}:${s.id}`
}

function readPinnedSessions(): Set<string> {
  try {
    const raw = window.localStorage.getItem(PINNED_SESSIONS_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [])
  } catch {
    return new Set()
  }
}

function writePinnedSessions(pinned: Set<string>) {
  window.localStorage.setItem(PINNED_SESSIONS_KEY, JSON.stringify([...pinned]))
}

function readGroupMode(): GroupMode {
  try {
    const raw = window.localStorage.getItem(GROUP_MODE_KEY)
    return raw === 'time' || raw === 'project' ? raw : 'project'
  } catch {
    return 'project'
  }
}

function writeGroupMode(mode: GroupMode) {
  window.localStorage.setItem(GROUP_MODE_KEY, mode)
}

function projectInfo(
  s: SessionSummaryDTO,
  t: (key: MessageKey) => string,
): { key: string; label: string; sortBy: string } {
  if (s.source === 'cockpit') {
    return { key: 'group:cockpit', label: t('sessions.groupChat'), sortBy: '0:cockpit' }
  }
  if (s.cwd) {
    const label = s.cwd.split('/').filter(Boolean).at(-1) || s.cwd
    return { key: `cwd:${s.cwd}`, label, sortBy: `0:${label.toLowerCase()}` }
  }
  if (s.source === 'codex') {
    return { key: 'source:codex', label: 'Codex sessions', sortBy: '1:codex' }
  }
  return { key: 'source:unknown', label: t('sessions.unknownProject'), sortBy: '2:unknown' }
}

function localDateKey(iso: string): string | null {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return null
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function daysSinceLocalDate(iso: string): number | null {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return null
  const today = new Date()
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const dayMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  return Math.floor((todayMidnight - dayMidnight) / DAY_MS)
}

function timeInfo(
  s: SessionSummaryDTO,
  t: (key: MessageKey) => string,
): { key: string; label: string; sortBy: string } {
  const days = daysSinceLocalDate(s.updatedAt)
  if (days === 0) return { key: 'time:today', label: t('sessions.today'), sortBy: '0' }
  if (days === 1) return { key: 'time:yesterday', label: t('sessions.yesterday'), sortBy: '1' }
  if (days != null && days > 1 && days < 7) {
    return { key: 'time:last-7-days', label: t('sessions.last7Days'), sortBy: '2' }
  }
  if (days != null && days >= 7 && days < 30) {
    return { key: 'time:last-30-days', label: t('sessions.last30Days'), sortBy: '3' }
  }
  const month = localDateKey(s.updatedAt)?.slice(0, 7) ?? 'unknown'
  return {
    key: `time:month:${month}`,
    label: month === 'unknown' ? t('sessions.older') : month,
    sortBy: `4:${month}`,
  }
}

function sourceMeta(s: SessionSummaryDTO, t: (key: MessageKey) => string): string {
  if (s.source === 'cockpit') return t('sessions.groupChat')
  if (s.source === 'claude-code') return 'Claude'
  if (s.source === 'codex') return 'Codex'
  const agent = AGENT_OPTIONS.find((a) => a.value === s.source)
  if (agent) return agent.label
  return String(s.source)
}

function agentForSource(source: string | undefined): AgentName | null {
  if (source === 'claude-code') return 'claude'
  const agent = AGENT_OPTIONS.find((a) => a.value === source)
  return agent?.value ?? null
}

function reviewRoomExtension(s: SessionSummaryDTO): { parentReviewRoomId?: string; sourceKind?: string } | null {
  const raw = s.extensions?.reviewRoom
  if (!raw || typeof raw !== 'object') return null
  const meta = raw as { parentReviewRoomId?: unknown; sourceKind?: unknown; enabled?: unknown }
  if (!meta.enabled) return null
  return {
    parentReviewRoomId: typeof meta.parentReviewRoomId === 'string' ? meta.parentReviewRoomId : undefined,
    sourceKind: typeof meta.sourceKind === 'string' ? meta.sourceKind : undefined,
  }
}

function extensionAgents(s: SessionSummaryDTO, key: 'agents' | 'followupAgents'): AgentName[] {
  const raw = s.extensions?.[key]
  return Array.isArray(raw) ? raw.filter((v): v is AgentName => typeof v === 'string') : []
}

function sessionAgents(s: SessionSummaryDTO): Set<AgentName> {
  const agents = new Set<AgentName>()
  const sourceAgent = agentForSource(s.source)
  if (sourceAgent) agents.add(sourceAgent)
  for (const agent of extensionAgents(s, 'agents')) agents.add(agent)
  for (const agent of extensionAgents(s, 'followupAgents')) agents.add(agent)
  return agents
}

function matchesViewMode(s: SessionSummaryDTO, viewMode: ViewMode): boolean {
  if (viewMode === 'all') return true
  if (viewMode === 'cockpit') return s.source === 'cockpit'
  return sessionAgents(s).has(viewMode)
}

function searchableText(s: SessionSummaryDTO, t: (key: MessageKey) => string, locale: ResolvedLocale): string {
  return [
    s.title,
    displayTitle(s.title, 60, locale),
    s.cwd ?? '',
    sourceMeta(s, t),
    [...sessionAgents(s)].map(labelForAgent).join(' '),
    s.id,
    s.messageCount == null ? '' : String(s.messageCount),
  ]
    .join(' ')
    .toLowerCase()
}

export function SessionList({ style }: { style?: CSSProperties }) {
  const { locale, t } = useI18n()
  const { enabledAgents, options: enabledAgentOptions } = useEnabledAgentOptions()
  const [sessions, setSessions] = useState<SessionSummaryDTO[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('all')
  const [groupMode, setGroupMode] = useState<GroupMode>(() => readGroupMode())
  const [recentOpen, setRecentOpen] = useState(false)
  const [pinned, setPinned] = useState<Set<string>>(() => readPinnedSessions())
  const [openProjects, setOpenProjects] = useState<Set<string>>(new Set())
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [newChooserOpen, setNewChooserOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [busyGroupId, setBusyGroupId] = useState<string | null>(null)
  const [activeBySession, setActiveBySession] = useState<Map<string, ActiveRunDTO[]>>(new Map())
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; session: SessionSummaryDTO } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement | null>(null)
  const navigate = useNavigate()
  const match = useMatch('/:source/:id')
  const selSource = match?.params.source
  const selId = match?.params.id

  useEffect(() => {
    let alive = true
    fetchSessions()
      .then((s) => alive && (setSessions(s), setLoading(false)))
      .catch((e) => alive && (setError(String(e)), setLoading(false)))
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    writePinnedSessions(pinned)
  }, [pinned])

  useEffect(() => {
    writeGroupMode(groupMode)
  }, [groupMode])

  useEffect(() => {
    if (viewMode !== 'all' && viewMode !== 'cockpit' && !enabledAgents.includes(viewMode)) {
      setViewMode('all')
    }
  }, [viewMode, enabledAgents])

  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    const onDown = (e: MouseEvent) => {
      if (!contextMenuRef.current?.contains(e.target as Node)) setContextMenu(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [contextMenu])

  useEffect(() => {
    let alive = true
    const refresh = () => {
      fetchRunningRuns()
        .then((runs) => {
          if (!alive) return
          const next = new Map<string, ActiveRunDTO[]>()
          for (const run of runs) {
            const key =
              run.kind === 'group-member' && run.groupThreadId
                ? `cockpit:${run.groupThreadId}`
                : run.source && run.sessionId
                  ? `${run.source}:${run.sessionId}`
                  : ''
            if (!key) continue
            next.set(key, [...(next.get(key) ?? []), run])
          }
          setActiveBySession(next)
        })
        .catch(() => {
          if (alive) setActiveBySession(new Map())
        })
    }
    refresh()
    const timer = window.setInterval(refresh, ACTIVE_RUN_POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const sourceFiltered = sessions.filter((s) => matchesViewMode(s, viewMode))
    const items = q ? sourceFiltered.filter((s) => searchableText(s, t, locale).includes(q)) : sourceFiltered
    return items.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }, [sessions, query, viewMode, locale, t])

  const projects = useMemo(() => {
    const map = new Map<
      string,
      { key: string; label: string; sortBy: string; updatedAt: string; items: SessionSummaryDTO[] }
    >()
    for (const s of filtered) {
      const info = groupMode === 'project' ? projectInfo(s, t) : timeInfo(s, t)
      const cur = map.get(info.key)
      if (cur) {
        cur.items.push(s)
        if (s.updatedAt > cur.updatedAt) cur.updatedAt = s.updatedAt
      } else {
        map.set(info.key, { ...info, updatedAt: s.updatedAt, items: [s] })
      }
    }
    return [...map.values()].sort((a, b) => {
      if (a.sortBy !== b.sortBy) return a.sortBy < b.sortBy ? -1 : 1
      return b.updatedAt.localeCompare(a.updatedAt)
    })
  }, [filtered, groupMode, t])

  const recentSessions = useMemo(() => {
    if (query.trim()) return []
    return filtered.slice(0, RECENT_SESSION_LIMIT)
  }, [filtered, query])

  useEffect(() => {
    if (!selSource || !selId) return
    const selected = sessions.find((s) => s.source === selSource && s.id === selId)
    if (!selected) return
    const key = (groupMode === 'project' ? projectInfo(selected, t) : timeInfo(selected, t)).key
    setOpenProjects((prev) => new Set(prev).add(key))
    setExpandedProjects((prev) => new Set(prev).add(key))
  }, [sessions, groupMode, selSource, selId, t])

  const handleCreateGroup = async () => {
    setCreatingGroup(true)
    try {
      const state = await createGroupThread({ agents: enabledAgents })
      const fresh = await fetchSessions()
      setSessions(fresh)
      setViewMode('cockpit')
      setNewChooserOpen(false)
      navigate(`/cockpit/${state.id}`)
    } catch (e) {
      setError(String(e))
    } finally {
      setCreatingGroup(false)
    }
  }

  const handleCreateReviewRoom = async (body: CreateReviewRoomBody) => {
    setCreatingGroup(true)
    try {
      const created = await createReviewRoom(body)
      const fresh = await fetchSessions()
      setSessions(fresh)
      setViewMode('cockpit')
      setNewChooserOpen(false)
      if (created.startError) setError(`Review Room created but auto-start failed: ${created.startError}`)
      navigate(`/cockpit/${created.groupThreadId}`)
    } catch (e) {
      setError(String(e))
    } finally {
      setCreatingGroup(false)
    }
  }

  const refreshSessions = async () => {
    const fresh = await fetchSessions()
    setSessions(fresh)
  }

  const startRename = (s: SessionSummaryDTO) => {
    setEditingId(s.id)
    setEditingTitle(displayTitle(s.title, 60, locale))
  }

  const submitRename = async (s: SessionSummaryDTO) => {
    const title = editingTitle.trim()
    if (!title) return
    setBusyGroupId(s.id)
    try {
      await renameGroupThread(s.id, title)
      await refreshSessions()
      setEditingId(null)
      setEditingTitle('')
      setError(null)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusyGroupId(null)
    }
  }

  const removeGroup = async (s: SessionSummaryDTO) => {
    if (!window.confirm(t('sessions.deleteConfirm', { title: displayTitle(s.title, 60, locale) }))) return
    setBusyGroupId(s.id)
    try {
      await deleteGroupThread(s.id)
      await refreshSessions()
      setPinned((prev) => {
        const next = new Set(prev)
        next.delete(sessionKey(s))
        return next
      })
      setError(null)
      if (s.source === selSource && s.id === selId) navigate('/')
    } catch (e) {
      setError(String(e))
    } finally {
      setBusyGroupId(null)
    }
  }

  const viewItems: { key: ViewMode; label: string; icon?: Parameters<typeof Icon>[0]['name'] }[] = [
    { key: 'all', label: t('sessions.all'), icon: 'folder' },
    { key: 'cockpit', label: t('sessions.groupChat') },
    ...enabledAgentOptions.map((agent) => ({ key: agent.value, label: agent.label })),
  ]

  const renderSessionRow = (s: SessionSummaryDTO) => {
    const selected = s.source === selSource && s.id === selId
    const key = sessionKey(s)
    const isPinned = pinned.has(key)
    const isGroup = s.source === 'cockpit'
    const editing = isGroup && editingId === s.id
    const busy = busyGroupId === s.id
    const activeRuns = activeBySession.get(key) ?? []
    const isRunning = activeRuns.length > 0
    const reviewExt = reviewRoomExtension(s)
    const isFreshChild = !!reviewExt?.parentReviewRoomId
    const visibleTitle = reviewExt ? localizeReviewRoomTitle(s.title, locale) : s.title
    const activeAgents = [...new Set(activeRuns.map((r) => r.agent))]
    const runningLabel =
      activeAgents.length === 1
        ? t('sessions.oneAgentReplying', { agent: labelForAgent(activeAgents[0]) })
        : t('sessions.nAgentsReplying', { count: activeAgents.length })
    const openContextMenu = (e: ReactMouseEvent) => {
      e.preventDefault()
      if (editing) return
      setContextMenu({ x: e.clientX, y: e.clientY, session: s })
    }
    return (
      <div
        className={`project-session-row ${isGroup ? 'group-row' : ''} ${selected ? 'selected' : ''} ${editing ? 'editing' : ''} ${isRunning ? 'running' : ''} ${isPinned ? 'pinned' : ''}`}
        key={key}
        onContextMenu={openContextMenu}
      >
        {editing ? (
          <form
            className="project-session-edit"
            onSubmit={(e) => {
              e.preventDefault()
              void submitRename(s)
            }}
          >
            <AgentIcon source="cockpit" size={22} className="project-session-icon" />
            <input
              className="project-session-edit-input"
              value={editingTitle}
              onChange={(e) => setEditingTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setEditingId(null)
                  setEditingTitle('')
                }
              }}
              disabled={busy}
              autoFocus
            />
            <button
              className="project-row-action"
              type="submit"
              title={t('common.save')}
              aria-label={t('common.save')}
              disabled={busy}
            >
              <Icon name="check" size={12} />
            </button>
            <button
              className="project-row-action"
              type="button"
              title={t('common.cancel')}
              aria-label={t('common.cancel')}
              disabled={busy}
              onClick={() => {
                setEditingId(null)
                setEditingTitle('')
              }}
            >
              <Icon name="close" size={12} />
            </button>
          </form>
        ) : (
          <Link to={`/${s.source}/${s.id}`} className="project-session-link">
            {isGroup ? (
              <AgentIcon source="cockpit" size={22} className="project-session-icon" />
            ) : (
              <AgentIcon source={s.source} size={30} className="project-session-icon" />
            )}
            <span className="project-session-title" title={visibleTitle}>
              {displayTitle(visibleTitle, 60, locale)}
              {isFreshChild && (
                <span className="project-session-fresh" title={t('sessions.freshReviewChild')}>
                  {' '}↑
                </span>
              )}
            </span>
            {isRunning ? (
              <span className="project-session-running" title={runningLabel}>
                <span className="project-session-running-dot" aria-hidden />
                <span>{runningLabel}</span>
              </span>
            ) : (
              <span className="project-session-time">{relativeTime(s.updatedAt, locale)}</span>
            )}
          </Link>
        )}
        {isPinned && !editing && (
          <Icon name="pin" size={11} className="project-session-pinned-indicator" />
        )}
      </div>
    )
  }

  const togglePin = (s: SessionSummaryDTO) => {
    const key = sessionKey(s)
    setPinned((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <aside className="sidebar project-sidebar" style={style}>
      <div className="project-nav">
        <button
          className="project-nav-item"
          onClick={() => setNewChooserOpen(true)}
          disabled={creatingGroup}
        >
          <Icon name="edit" size={16} />
          <span>{t('sessions.newChat')}</span>
        </button>
        <button
          className={`project-nav-item ${searchOpen ? 'active' : ''}`}
          onClick={() => setSearchOpen((v) => !v)}
        >
          <Icon name="search" size={16} />
          <span>{t('sessions.search')}</span>
        </button>
      </div>

      {(searchOpen || query) && (
        <div className="project-search">
          <Icon name="search" size={13} className="project-search-icon" />
          <input
            className="project-search-input"
            placeholder={t('sessions.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>
      )}

      <div
        className="project-view-switch"
        style={{
          gridTemplateColumns: `repeat(${viewItems.length}, minmax(0, 1fr))`,
          width: `min(${viewItems.length * 46 + 6}px, calc(100% - 20px))`,
        }}
      >
        {viewItems.map((item) => (
          <button
            key={item.key}
            className={`project-view-item ${viewMode === item.key ? 'active' : ''}`}
            onClick={() => setViewMode(item.key)}
            title={item.label}
            aria-label={item.label}
            aria-pressed={viewMode === item.key}
          >
            {item.icon ? <Icon name={item.icon} size={18} /> : <AgentIcon source={item.key} size={24} />}
          </button>
        ))}
      </div>

      <div className="project-list">
        {loading && <div className="project-empty">{t('common.loading')}</div>}
        {error && <div className="project-empty">{t('sessions.loadFailed', { error })}</div>}
        {!loading && !error && projects.length === 0 && (
          <div className="project-empty">
            <div className="project-empty-title">{query ? t('sessions.noMatches') : t('sessions.noSessions')}</div>
            <div className="project-empty-copy">{t('sessions.emptyHint')}</div>
          </div>
        )}

        {recentSessions.length > 0 && (
          <section className="project-recent">
            <button
              className={`project-list-head project-section-toggle ${recentOpen ? 'open' : ''}`}
              onClick={() => setRecentOpen((v) => !v)}
            >
              <span className="project-list-head-main">
                <Icon name="clock" size={12} />
                <span>{t('sessions.recent')}</span>
              </span>
              <span className="project-group-count">{recentSessions.length}</span>
            </button>
            {recentOpen && (
              <div className="project-session-list recent-session-list">
                {recentSessions.map((s) => renderSessionRow(s))}
              </div>
            )}
          </section>
        )}

        {projects.length > 0 && (
          <div className="project-list-head project-group-mode-head">
            <span className="project-list-head-main project-group-mode-label">
              <span>{t('sessions.grouping')}</span>
            </span>
            <div className="project-group-mode-switch" role="group" aria-label={t('sessions.groupingLabel')}>
              <button
                className={`project-group-mode-item ${groupMode === 'project' ? 'active' : ''}`}
                onClick={() => setGroupMode('project')}
                title={t('sessions.byProject')}
                aria-pressed={groupMode === 'project'}
              >
                <Icon name="folder" size={12} />
                <span>{t('sessions.project')}</span>
              </button>
              <button
                className={`project-group-mode-item ${groupMode === 'time' ? 'active' : ''}`}
                onClick={() => setGroupMode('time')}
                title={t('sessions.byTime')}
                aria-pressed={groupMode === 'time'}
              >
                <Icon name="clock" size={12} />
                <span>{t('sessions.time')}</span>
              </button>
            </div>
          </div>
        )}

        {projects.map((project) => {
          const open = openProjects.has(project.key) || query.trim().length > 0
          const expanded = expandedProjects.has(project.key) || query.trim().length > 0
          const visibleItems = expanded ? project.items : project.items.slice(0, MAX_COLLAPSED_ITEMS)
          const hiddenCount = project.items.length - visibleItems.length
          return (
            <section className="project-group" key={project.key}>
              <button
                className={`project-group-head ${open ? 'open' : ''}`}
                title={project.label}
                onClick={() =>
                  setOpenProjects((prev) => {
                    const next = new Set(prev)
                    if (next.has(project.key)) next.delete(project.key)
                    else next.add(project.key)
                    return next
                  })
                }
              >
                {project.key === 'group:cockpit' ? (
                  <AgentIcon source="cockpit" size={22} />
                ) : (
                  <Icon name={groupMode === 'project' ? 'folder' : 'clock'} size={15} />
                )}
                <span>{project.label}</span>
                <span className="project-group-count">{project.items.length}</span>
              </button>
              {open && (
                <div className="project-session-list">
                  {visibleItems.map((s) => renderSessionRow(s))}
                  {hiddenCount > 0 && (
                    <button
                      className="project-expand"
                      onClick={() => setExpandedProjects((prev) => new Set(prev).add(project.key))}
                    >
                      {t('sessions.showMore')}
                    </button>
                  )}
                </div>
              )}
            </section>
          )
        })}
      </div>
      {contextMenu && (() => {
        const s = contextMenu.session
        const key = sessionKey(s)
        const isGroup = s.source === 'cockpit'
        const isPinned = pinned.has(key)
        const menuWidth = 180
        const menuHeight = isGroup ? 108 : 40
        const x = Math.min(contextMenu.x, window.innerWidth - menuWidth - 8)
        const y = Math.min(contextMenu.y, window.innerHeight - menuHeight - 8)
        return (
          <div
            ref={contextMenuRef}
            className="session-context-menu"
            style={{ left: x, top: y }}
            role="menu"
          >
            <button
              type="button"
              className="session-context-item"
              onClick={() => {
                togglePin(s)
                setContextMenu(null)
              }}
            >
              <Icon name="pin" size={13} />
              <span>{isPinned ? t('sessions.unpin') : t('sessions.pin')}</span>
            </button>
            {isGroup && (
              <button
                type="button"
                className="session-context-item"
                onClick={() => {
                  startRename(s)
                  setContextMenu(null)
                }}
              >
                <Icon name="edit" size={13} />
                <span>{t('sessions.renameGroup')}</span>
              </button>
            )}
            {isGroup && (
              <button
                type="button"
                className="session-context-item danger"
                onClick={() => {
                  setContextMenu(null)
                  void removeGroup(s)
                }}
              >
                <Icon name="trash" size={13} />
                <span>{t('sessions.deleteGroup')}</span>
              </button>
            )}
          </div>
        )
      })()}
      {newChooserOpen && (
        <NewConversationDialog
          busy={creatingGroup}
          sessions={sessions}
          onCancel={() => setNewChooserOpen(false)}
          onCreateGroup={handleCreateGroup}
          onCreateReviewRoom={handleCreateReviewRoom}
        />
      )}
    </aside>
  )
}

type ReviewSourceKind = 'folder' | 'files' | 'existing-session' | 'freeform'
const DEFAULT_REVIEW_AGENTS: AgentName[] = ['claude', 'codex']
// 仓库本质上也是文件夹,文档本质上也是文件：新建入口只保留用户能明确区分的四类来源。
const REVIEW_KIND_OPTIONS: {
  value: ReviewSourceKind
  labelKey: MessageKey
  hintKey: MessageKey
  icon: 'folder' | 'file-text' | 'clock' | 'edit'
}[] = [
  { value: 'folder', labelKey: 'newChat.kindDirectory', hintKey: 'newChat.kindDirectoryHint', icon: 'folder' },
  { value: 'files', labelKey: 'newChat.kindFiles', hintKey: 'newChat.kindFilesHint', icon: 'file-text' },
  { value: 'existing-session', labelKey: 'newChat.kindExistingSession', hintKey: 'newChat.kindExistingSessionHint', icon: 'clock' },
  { value: 'freeform', labelKey: 'newChat.kindFreeform', hintKey: 'newChat.kindFreeformHint', icon: 'edit' },
]

function NewConversationDialog({
  busy,
  sessions,
  onCancel,
  onCreateGroup,
  onCreateReviewRoom,
}: {
  busy: boolean
  sessions: SessionSummaryDTO[]
  onCancel: () => void
  onCreateGroup: () => void
  onCreateReviewRoom: (body: CreateReviewRoomBody) => void
}) {
  const { locale, t } = useI18n()
  const { enabledAgents, options: enabledAgentOptions } = useEnabledAgentOptions()
  const [mode, setMode] = useState<'review' | 'group'>('review')
  const [kind, setKind] = useState<ReviewSourceKind>('folder')
  const [selectedFolder, setSelectedFolder] = useState('')
  const [selectedFiles, setSelectedFiles] = useState<string[]>([])
  const [freeformText, setFreeformText] = useState('')
  const [selectedSessionKey, setSelectedSessionKey] = useState('')
  const [sessionQuery, setSessionQuery] = useState('')
  const [pickerError, setPickerError] = useState<string | null>(null)
  const [goal, setGoal] = useState(() => t('actions.reviewRoomGoal'))
  const [participants, setParticipants] = useState<AgentName[]>(() => {
    const preferred = DEFAULT_REVIEW_AGENTS.filter((agent) => enabledAgents.includes(agent))
    return preferred.length ? preferred : enabledAgents
  })
  const [discussion, setDiscussion] = useState<'parallel' | 'serial'>('parallel')

  const activeKind = REVIEW_KIND_OPTIONS.find((k) => k.value === kind)!
  const paths = kind === 'folder' ? (selectedFolder ? [selectedFolder] : []) : selectedFiles
  const selectedSession = sessions.find((session) => sessionKey(session) === selectedSessionKey)
  const visibleSessions = useMemo(() => {
    const query = sessionQuery.trim().toLocaleLowerCase()
    return [...sessions]
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .filter((session) => {
        if (!query) return true
        return [session.title, session.cwd ?? '', sourceMeta(session, t)]
          .some((value) => value.toLocaleLowerCase().includes(query))
      })
      .slice(0, 50)
  }, [sessionQuery, sessions, t])
  const canSubmit = mode === 'group'
    ? true
    : kind === 'freeform'
      ? freeformText.trim().length > 0 && goal.trim().length > 0
      : kind === 'existing-session'
        ? Boolean(selectedSession) && participants.length >= 1 && goal.trim().length > 0
        : paths.length > 0 && participants.length >= 1 && goal.trim().length > 0

  const toggleAgent = (agent: AgentName) => {
    setParticipants((prev) => {
      if (!prev.includes(agent)) return [...prev, agent]
      return prev.length === 1 ? prev : prev.filter((a) => a !== agent)
    })
  }

  useEffect(() => {
    if (participants.length < 2 && discussion === 'serial') setDiscussion('parallel')
  }, [discussion, participants.length])

  useEffect(() => {
    setParticipants((current) => {
      const visible = current.filter((agent) => enabledAgents.includes(agent))
      return visible.length ? visible : enabledAgents
    })
  }, [enabledAgents])

  const submit = () => {
    if (mode === 'group') {
      onCreateGroup()
      return
    }
    const goalText = goal.trim()
    let source: CreateReviewRoomBody['source']
    if (kind === 'freeform') {
      source = { kind: 'freeform', freeformText: freeformText.trim() }
    } else if (kind === 'existing-session') {
      if (!selectedSession) return
      source = selectedSession.source === 'cockpit'
        ? { kind: 'group-thread', groupThreadId: selectedSession.id, title: selectedSession.title }
        : {
            kind: selectedSession.hasFollowups ? 'cockpit-followup' : 'native-session',
            source: selectedSession.source,
            sessionId: selectedSession.id,
            title: selectedSession.title,
          }
    } else if (kind === 'files') {
      source = { kind: 'files', paths }
    } else {
      source = { kind: 'directory', path: paths[0] }
    }
    onCreateReviewRoom({
      source,
      goal: goalText,
      participants,
      mode: discussion,
      startReview: true,
      promptLocale: locale.startsWith('zh') ? 'zh-CN' : 'en',
    })
  }

  const browse = async (sourceKind: ReviewSourceKind = kind) => {
    setPickerError(null)
    try {
      const pickerKind = sourceKind === 'folder' ? 'directory' : 'file'
      const picked = await pickLocalPaths(pickerKind)
      if (!picked.length) return
      if (sourceKind === 'folder') {
        setSelectedFolder(picked[0])
      } else {
        setSelectedFiles((current) => [...new Set([...current, ...picked])])
      }
    } catch (err) {
      setPickerError(
        (err as Error)?.message === 'native-picker-unavailable'
          ? t('newChat.pickerUnavailable')
          : String((err as Error)?.message ?? err),
      )
    }
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal new-conversation-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">{t('newChat.title')}</span>
          <button className="modal-close" onClick={onCancel} aria-label={t('common.close')}>×</button>
        </div>
        <div className="modal-body">
          <div className="new-conversation-grid" role="group" aria-label={t('newChat.title')}>
            <button
              type="button"
              className={`new-conversation-option ${mode === 'review' ? 'active' : ''}`}
              onClick={() => setMode('review')}
            >
              <Icon name="folder" size={18} />
              <span>{t('newChat.reviewRoom')}</span>
              <small>{t('newChat.reviewRoomHint')}</small>
            </button>
            <button
              type="button"
              className={`new-conversation-option ${mode === 'group' ? 'active' : ''}`}
              onClick={() => setMode('group')}
            >
              <AgentIcon source="cockpit" size={28} />
              <span>{t('newChat.blankGroup')}</span>
              <small>{t('newChat.blankGroupHint')}</small>
            </button>
          </div>
          {mode === 'review' && (
            <>
              <div className="modal-section">
                <span className="modal-label">{t('newChat.sourceKind')}</span>
                <div className="review-source-grid" role="group" aria-label={t('newChat.sourceKind')}>
                  {REVIEW_KIND_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className={`review-source-option ${kind === opt.value ? 'active' : ''}`}
                      onClick={() => {
                        setKind(opt.value)
                        setPickerError(null)
                      }}
                      title={t(opt.hintKey)}
                      aria-pressed={kind === opt.value}
                    >
                      <Icon name={opt.icon} size={16} />
                      <span>{t(opt.labelKey)}</span>
                    </button>
                  ))}
                </div>
                <span className="modal-hint source-hint">{t(activeKind.hintKey)}</span>
              </div>
              {kind === 'freeform' ? (
                <label className="modal-section">
                  <span className="modal-label">{t('newChat.content')}</span>
                  <textarea
                    className="modal-textarea"
                    value={freeformText}
                    onChange={(e) => setFreeformText(e.target.value)}
                    placeholder={t('newChat.freeformPlaceholder')}
                    rows={5}
                    autoFocus
                  />
                </label>
              ) : kind === 'existing-session' ? (
                <div className="modal-section session-source-section">
                  <div className="source-section-head">
                    <span className="modal-label">{t('newChat.existingSession')}</span>
                    {selectedSession && (
                      <span className="source-selection-count">{t('newChat.oneSessionSelected')}</span>
                    )}
                  </div>
                  <div className="session-source-picker">
                    <div className="session-source-search">
                      <Icon name="search" size={14} />
                      <input
                        value={sessionQuery}
                        onChange={(e) => setSessionQuery(e.target.value)}
                        placeholder={t('newChat.searchSessions')}
                        aria-label={t('newChat.searchSessions')}
                        autoFocus
                      />
                      {sessionQuery && (
                        <button
                          type="button"
                          onClick={() => setSessionQuery('')}
                          aria-label={t('common.clear')}
                        >
                          <Icon name="close" size={12} />
                        </button>
                      )}
                    </div>
                    <div className="session-source-results" role="listbox" aria-label={t('newChat.existingSession')}>
                      {visibleSessions.length === 0 ? (
                        <div className="session-source-empty">{t('newChat.noSessionsFound')}</div>
                      ) : (
                        visibleSessions.map((session) => {
                          const key = sessionKey(session)
                          const selected = key === selectedSessionKey
                          const project = session.cwd?.split('/').filter(Boolean).pop()
                          return (
                            <button
                              key={key}
                              type="button"
                              className={`session-source-result ${selected ? 'selected' : ''}`}
                              role="option"
                              aria-selected={selected}
                              onClick={() => setSelectedSessionKey(key)}
                            >
                              <AgentIcon source={session.source} size={24} />
                              <span className="session-source-result-copy">
                                <strong>{displayTitle(session.title, 72, locale)}</strong>
                                <small>
                                  {sourceMeta(session, t)}
                                  {project ? ` · ${project}` : ''}
                                  {` · ${relativeTime(session.updatedAt, locale)}`}
                                </small>
                              </span>
                              <span className="session-source-check" aria-hidden>
                                {selected && <Icon name="check" size={14} />}
                              </span>
                            </button>
                          )
                        })
                      )}
                    </div>
                  </div>
                  {visibleSessions.length === 50 && (
                    <span className="modal-hint">{t('newChat.refineSessionSearch')}</span>
                  )}
                </div>
              ) : (
                <div className="modal-section source-picker-section">
                  <div className="source-section-head">
                    <span className="modal-label">
                      {kind === 'files'
                        ? paths.length ? t('newChat.selectedFilesLabel') : t('newChat.kindFiles')
                        : paths.length ? t('newChat.selectedFolderLabel') : t('newChat.kindDirectory')}
                    </span>
                    {kind === 'files' && paths.length > 0 && (
                      <button type="button" className="source-clear-button" onClick={() => setSelectedFiles([])}>
                        {t('newChat.clearFiles')}
                      </button>
                    )}
                  </div>
                  <button type="button" className="native-source-picker" onClick={() => void browse()}>
                    <span className="native-source-picker-icon">
                      <Icon name={kind === 'files' ? 'file-text' : 'folder'} size={20} />
                    </span>
                    <span className="native-source-picker-copy">
                      <strong>
                        {kind === 'files'
                          ? paths.length ? t('newChat.addFiles') : t('newChat.selectFiles')
                          : paths.length ? t('newChat.changeFolder') : t('newChat.selectFolder')}
                      </strong>
                      <small>
                        {kind === 'files'
                          ? paths.length
                            ? t('newChat.selectedFiles', { count: paths.length })
                            : t('newChat.multiFilePickerHint')
                          : paths.length
                            ? paths[0]
                          : t('newChat.systemPickerHint')}
                      </small>
                    </span>
                    <span className="native-source-picker-action">
                      {kind === 'files' && paths.length
                        ? t('newChat.add')
                        : paths.length ? t('newChat.changeSelection') : t('newChat.browse')}
                    </span>
                  </button>
                  {kind === 'files' && selectedFiles.length > 0 && (
                    <div className="selected-file-list" aria-label={t('newChat.selectedFilesLabel')}>
                      {selectedFiles.map((path) => {
                        const name = path.split('/').filter(Boolean).pop() ?? path
                        return (
                          <div className="selected-file-row" key={path}>
                            <span className="selected-file-icon"><Icon name="file-text" size={14} /></span>
                            <span className="selected-file-copy">
                              <strong>{name}</strong>
                              <small>{path}</small>
                            </span>
                            <button
                              type="button"
                              onClick={() => setSelectedFiles((current) => current.filter((item) => item !== path))}
                              title={t('newChat.removeFile', { name })}
                              aria-label={t('newChat.removeFile', { name })}
                            >
                              <Icon name="close" size={12} />
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  )}
                  {pickerError && <span className="modal-hint danger">{pickerError}</span>}
                </div>
              )}
              <div className="modal-section">
                <span className="modal-label">{t('newChat.participants')}</span>
                <div className="review-agents-row" role="group" aria-label={t('newChat.participants')}>
                  {enabledAgentOptions.map((agent) => (
                    <button
                      key={agent.value}
                      type="button"
                      className={`review-agent-chip ${participants.includes(agent.value) ? 'active' : ''}`}
                      onClick={() => toggleAgent(agent.value)}
                      aria-pressed={participants.includes(agent.value)}
                      disabled={participants.includes(agent.value) && participants.length === 1}
                      title={participants.includes(agent.value) && participants.length === 1 ? t('newChat.keepOneParticipant') : undefined}
                    >
                      <AgentIcon source={agent.value} size={16} />
                      <span>{agent.label}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="modal-section">
                <span className="modal-label">{t('newChat.discussionMode')}</span>
                <div className="review-kind-row" role="group" aria-label={t('newChat.discussionMode')}>
                  <button
                    type="button"
                    className={`review-kind-item ${discussion === 'parallel' ? 'active' : ''}`}
                    onClick={() => setDiscussion('parallel')}
                    aria-pressed={discussion === 'parallel'}
                    title={t('newChat.parallelHint')}
                  >
                    {t('newChat.parallel')}
                  </button>
                  <button
                    type="button"
                    className={`review-kind-item ${discussion === 'serial' ? 'active' : ''}`}
                    onClick={() => setDiscussion('serial')}
                    aria-pressed={discussion === 'serial'}
                    title={participants.length < 2 ? t('newChat.serialNeedsTwo') : t('newChat.serialHint')}
                    disabled={participants.length < 2}
                  >
                    {t('newChat.serial')}
                  </button>
                </div>
              </div>
              <label className="modal-section">
                <span className="modal-label">{t('newChat.goal')}</span>
                <textarea
                  className="modal-textarea"
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  placeholder={t('newChat.goalPlaceholder')}
                  rows={2}
                />
                <span className="modal-hint">{t('reviewSetup.briefHint')}</span>
              </label>
            </>
          )}
        </div>
        <div className="modal-actions">
          <button className="modal-btn" onClick={onCancel} disabled={busy}>{t('common.cancel')}</button>
          <button
            className="modal-btn primary"
            onClick={submit}
            disabled={busy || !canSubmit}
          >
            {mode === 'review' ? t('reviewSetup.createAndStart') : t('newChat.create')}
          </button>
        </div>
      </div>
    </div>
  )
}
