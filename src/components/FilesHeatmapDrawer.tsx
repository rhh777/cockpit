import { useEffect, useMemo, useState } from 'react'
import type { FileHeatEntry, ToolPair } from '../lib/timeline'
import { computeFileHeatmap } from '../lib/timeline'
import { shortPath } from '../lib/apply-patch'
import { AgentIcon, agentLabel } from './AgentIcon'

interface GitChangedFile { path: string; status: string }

type Cross = 'ai-and-git' | 'ai-not-in-git' | 'git-not-in-ai' | 'none'

// 方向 D:文件热力图 · 语义信号版
// 除了触碰次数,给出:
//   🔴 盲改(写之前没读)
//   ⚠️ 挣扎(写 ≥ 5 或有 error)
//   🟢 仅浏览(只读)
//   🔀 git 已改动(有落地);➖ git 未变(可能只是看看)
// 目标是把这个抽屉从"数字仪表盘"变成"review 待办清单"。
export function FilesHeatmapDrawer({
  pairs,
  cwd,
  open,
  onClose,
}: {
  pairs: ToolPair[]
  cwd?: string
  open: boolean
  onClose: () => void
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [gitFiles, setGitFiles] = useState<GitChangedFile[] | null>(null)
  const [gitError, setGitError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    if (!open || !cwd) {
      setGitFiles(null)
      setGitError(null)
      return
    }
    let cancelled = false
    setGitError(null)
    fetch(`/api/git/changed?cwd=${encodeURIComponent(cwd)}`)
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(`git ${r.status}`))))
      .then((body: { root: string | null; files: GitChangedFile[] }) => {
        if (cancelled) return
        setGitFiles(body.files ?? [])
      })
      .catch((err) => {
        if (cancelled) return
        setGitError(String(err))
        setGitFiles([])
      })
    return () => { cancelled = true }
  }, [open, cwd])

  const entries = useMemo(() => (open ? computeFileHeatmap(pairs) : []), [open, pairs])
  const gitSet = useMemo(() => new Set((gitFiles ?? []).map((f) => f.path)), [gitFiles])
  const aiSet = useMemo(() => new Set(entries.map((e) => e.path)), [entries])
  const gitOnly = useMemo(
    () => (gitFiles ?? []).filter((f) => !aiSet.has(f.path)),
    [gitFiles, aiSet],
  )

  const summary = useMemo(() => {
    let blind = 0
    let struggle = 0
    let readOnly = 0
    let touchedAndInGit = 0
    for (const e of entries) {
      if (e.blindWrite) blind++
      if (e.struggle) struggle++
      if (e.readOnly) readOnly++
      if (gitSet.has(e.path)) touchedAndInGit++
    }
    return { blind, struggle, readOnly, touchedAndInGit, gitOnly: gitOnly.length }
  }, [entries, gitSet, gitOnly])

  if (!open) return null

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer-content files-drawer-content" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <div className="drawer-title-area">
            <h3>文件热力</h3>
            <span className="drawer-subtitle">
              {entries.length} 文件
              {summary.blind > 0 && <> · <span className="tag-blind-inline">{summary.blind} 盲改</span></>}
              {summary.struggle > 0 && <> · <span className="tag-struggle-inline">{summary.struggle} 挣扎</span></>}
              {summary.readOnly > 0 && <> · {summary.readOnly} 仅浏览</>}
              {gitFiles && <> · git 已落地 {summary.touchedAndInGit}</>}
              {gitError && <> · <span className="patch-error">git 读取失败</span></>}
            </span>
          </div>
          <button className="drawer-close" onClick={onClose} title="关闭 (Esc)">✕</button>
        </div>

        <div className="drawer-body files-drawer-body">
          {entries.length === 0 ? (
            <div className="files-empty">还没有 tool_use 触碰到具体文件路径。Bash 命令暂不纳入统计。</div>
          ) : (
            <div className="files-heat-list">
              {entries.map((e) => (
                <FileRow
                  key={e.path}
                  entry={e}
                  inGit={gitSet.has(e.path)}
                  gitTracked={gitFiles !== null}
                  expanded={expanded.has(e.path)}
                  onToggle={() => toggle(e.path)}
                />
              ))}
            </div>
          )}

          {gitOnly.length > 0 && (
            <div className="files-git-untouched">
              <div className="files-git-untouched-head">
                📝 你手改了但 AI 没碰过的文件 · {gitOnly.length}
              </div>
              {gitOnly.map((f) => (
                <div key={f.path} className="git-only-row" title={f.path}>
                  <span className="touch-kind">{f.status}</span>
                  <span className="file-row-name">{shortPath(f.path)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function crossOf(inGit: boolean, gitTracked: boolean): Cross {
  if (!gitTracked) return 'none'
  if (inGit) return 'ai-and-git'
  return 'ai-not-in-git'
}

function FileRow({
  entry,
  inGit,
  gitTracked,
  expanded,
  onToggle,
}: {
  entry: FileHeatEntry
  inGit: boolean
  gitTracked: boolean
  expanded: boolean
  onToggle: () => void
}) {
  const label = shortPath(entry.path)
  const cross = crossOf(inGit, gitTracked)
  // 只在"写了但 git 没变"这种意外情况才提示;git 已落地是常态,不占视觉。
  const flagNoDiff = cross === 'ai-not-in-git' && entry.writes > 0
  const tips: string[] = []
  if (entry.blindWrite) tips.push('盲改:写之前没读过')
  if (entry.struggle) tips.push(`挣扎:写 ${entry.writes} 次${entry.errors ? ` · ${entry.errors} 错` : ''}`)
  if (entry.readOnly) tips.push('仅浏览')
  if (flagNoDiff) tips.push('AI 写过,但 git 里没变化')
  return (
    <div className={`file-row ${expanded ? 'expanded' : ''} ${entry.blindWrite ? 'is-blind' : ''} ${entry.struggle ? 'is-struggle' : ''}`}>
      <button className="file-row-head file-row-head-semantic" onClick={onToggle} title={tips.length ? `${entry.path}\n${tips.join(' · ')}` : entry.path}>
        <span className="file-row-caret">{expanded ? '▾' : '▸'}</span>
        <span className="file-row-name">{label}</span>
        <span className="file-row-marks" aria-hidden>
          {entry.blindWrite && <span className="mark mark-blind" title="盲改:写之前没读过">●</span>}
          {entry.struggle && !entry.blindWrite && <span className="mark mark-struggle" title={`挣扎:写 ${entry.writes} 次`}>●</span>}
          {entry.readOnly && <span className="mark mark-readonly" title="仅浏览">○</span>}
          {flagNoDiff && <span className="mark mark-nodiff" title="AI 写过,但 git 里没变化">⌀</span>}
        </span>
        {(entry.adds > 0 || entry.dels > 0) && (
          <span className="file-row-diff">
            <span className="patch-add">+{entry.adds}</span><span className="patch-del">−{entry.dels}</span>
          </span>
        )}
        <span className="file-row-count">{entry.count}</span>
      </button>
      {expanded && (
        <div className="file-row-body">
          {entry.touches.map((t, i) => (
            <div key={i} className={`touch-row ${t.isError ? 'has-error' : ''}`}>
              <span className={`touch-kind touch-${t.kind}`}>{t.kind === 'read' ? '读' : t.kind === 'write' ? '写' : '·'}</span>
              <span className="touch-tool">{t.toolName}</span>
              {t.agent && (
                <span className="touch-agent">
                  <AgentIcon agent={t.agent as 'claude' | 'codex'} size={12} /> {agentLabel(t.agent)}
                </span>
              )}
              {(t.adds != null || t.dels != null) && (
                <span className="touch-diff">
                  {t.adds ? <span className="patch-add">+{t.adds}</span> : null}
                  {t.dels ? <span className="patch-del">−{t.dels}</span> : null}
                </span>
              )}
              {t.isError && <span className="touch-error">error</span>}
            </div>
          ))}
          <div className="file-row-path" title="完整路径">{entry.path}</div>
        </div>
      )}
    </div>
  )
}
