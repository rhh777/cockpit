import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { Link, useMatch, useNavigate } from 'react-router-dom'
import {
  createGroupThread,
  deleteGroupThread,
  fetchSessions,
  renameGroupThread,
  type SessionSummaryDTO,
} from '../lib/api'
import { displayTitle, relativeTime } from '../lib/display'
import { AgentIcon } from '../components/AgentIcon'
import { Icon } from '../components/Icon'
import { useI18n, type MessageKey, type ResolvedLocale } from '../lib/i18n'

type ViewMode = 'all' | 'cockpit' | 'claude-code' | 'codex'
type GroupMode = 'project' | 'time'

const PINNED_SESSIONS_KEY = 'cockpit.pinnedSessions'
const GROUP_MODE_KEY = 'cockpit.sessionGroupMode'
const MAX_COLLAPSED_ITEMS = 5
const RECENT_SESSION_LIMIT = 5
const DAY_MS = 24 * 60 * 60 * 1000

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
  return String(s.source)
}

function searchableText(s: SessionSummaryDTO, t: (key: MessageKey) => string, locale: ResolvedLocale): string {
  return [
    s.title,
    displayTitle(s.title, 60, locale),
    s.cwd ?? '',
    sourceMeta(s, t),
    s.id,
    s.messageCount == null ? '' : String(s.messageCount),
  ]
    .join(' ')
    .toLowerCase()
}

export function SessionList({ style }: { style?: CSSProperties }) {
  const { locale, t } = useI18n()
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
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [busyGroupId, setBusyGroupId] = useState<string | null>(null)
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const sourceFiltered =
      viewMode === 'all' ? sessions : sessions.filter((s) => s.source === viewMode)
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
      const state = await createGroupThread()
      const fresh = await fetchSessions()
      setSessions(fresh)
      setViewMode('cockpit')
      navigate(`/cockpit/${state.id}`)
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
    { key: 'cockpit', label: t('sessions.groupChat'), icon: 'users' },
    { key: 'claude-code', label: 'Claude' },
    { key: 'codex', label: 'Codex' },
  ]

  const renderSessionRow = (s: SessionSummaryDTO) => {
    const selected = s.source === selSource && s.id === selId
    const key = sessionKey(s)
    const isPinned = pinned.has(key)
    const isGroup = s.source === 'cockpit'
    const editing = isGroup && editingId === s.id
    const busy = busyGroupId === s.id
    return (
      <div
        className={`project-session-row ${isGroup ? 'group-row' : ''} ${selected ? 'selected' : ''} ${editing ? 'editing' : ''}`}
        key={key}
      >
        {editing ? (
          <form
            className="project-session-edit"
            onSubmit={(e) => {
              e.preventDefault()
              void submitRename(s)
            }}
          >
            <Icon name="users" size={14} className="project-session-icon" />
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
              <Icon name="users" size={14} className="project-session-icon" />
            ) : (
              <AgentIcon source={s.source} size={16} className="project-session-icon" />
            )}
            <span className="project-session-title" title={s.title}>
              {displayTitle(s.title, 60, locale)}
            </span>
            <span className="project-session-time">{relativeTime(s.updatedAt, locale)}</span>
          </Link>
        )}
        {isGroup && !editing && (
          <button
            className="project-row-action"
            title={t('sessions.renameGroup')}
            aria-label={t('sessions.renameGroup')}
            disabled={busy}
            onClick={() => startRename(s)}
          >
            <Icon name="edit" size={12} />
          </button>
        )}
        {isGroup && !editing && (
          <button
            className="project-row-action danger"
            title={t('sessions.deleteGroup')}
            aria-label={t('sessions.deleteGroup')}
            disabled={busy}
            onClick={() => void removeGroup(s)}
          >
            <Icon name="trash" size={12} />
          </button>
        )}
        {!editing && (
          <button
            className={`session-pin project-pin ${isPinned ? 'active' : ''}`}
            title={isPinned ? t('sessions.unpin') : t('sessions.pin')}
            aria-label={isPinned ? t('sessions.unpin') : t('sessions.pin')}
            onClick={() =>
              setPinned((prev) => {
                const next = new Set(prev)
                if (next.has(key)) next.delete(key)
                else next.add(key)
                return next
              })
            }
          >
            <Icon name="pin" size={12} />
          </button>
        )}
      </div>
    )
  }

  return (
    <aside className="sidebar project-sidebar" style={style}>
      <div className="project-nav">
        <button
          className="project-nav-item"
          onClick={handleCreateGroup}
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

      <div className="project-view-switch">
        {viewItems.map((item) => (
          <button
            key={item.key}
            className={`project-view-item ${viewMode === item.key ? 'active' : ''}`}
            onClick={() => setViewMode(item.key)}
          >
            {item.icon ? <Icon name={item.icon} size={13} /> : <AgentIcon source={item.key} size={14} />}
            <span>{item.label}</span>
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
                <Icon
                  name="chevron-right"
                  size={12}
                  className={`project-group-caret ${recentOpen ? 'open' : ''}`}
                />
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
            <span className="project-list-head-main">
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
                <Icon
                  name="chevron-right"
                  size={12}
                  className={`project-group-caret ${open ? 'open' : ''}`}
                />
                <Icon name={groupMode === 'project' ? 'folder' : 'clock'} size={15} />
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
    </aside>
  )
}
