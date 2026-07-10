// 实时观察单个 (source, id) session 的原生 jsonl + follow-up jsonl 变化。
// macOS spike 已确认 fs.watch 对单文件 append 100% 可靠且无丢失(详见 commit log)。
// 为减少抖动,'change' 事件按 50ms 防抖批量处理。
//
// 与现有 changes-service 协议保持一致:
//  - 中段插入(boundary 前 native 长度变化)→ reset,前端走全量重拉(不变量 11/12)。
//  - 文件被截断/重写(total < lastTotal)→ reset。
//  - 普通尾部追加 → 增量 newEvents。
//
// 多个 SSE client 订阅同一 session 时共享一个 watcher,引用计数到 0 时关闭。

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { loaderBySource } from '../loaders'
import type { EventEnvelope, JsonlIncrementalState, Source } from '../loaders/types'
import { followupsFile } from '../store/paths'
import { loadSessionDetail } from '../sessions-service'

export type WatcherUpdate =
  | { kind: 'append'; total: number; newEvents: EventEnvelope[] }
  | { kind: 'reset'; reason: 'truncated' | 'native-middle-insert' | 'load-error' }

export type WatcherListener = (msg: WatcherUpdate) => void

interface Entry {
  refs: Set<WatcherListener>
  nativeWatcher: fs.FSWatcher | null
  followupWatcher: fs.FSWatcher | null
  // 目标文件尚不存在(或被删/换 inode)时,watcher 为 null;周期性补建(docs/12 F2)。
  rebuildTimer: NodeJS.Timeout | null
  // 追踪上次解析的状态,用于算 diff。
  lastTotal: number
  lastNativeTotal: number
  incremental: JsonlIncrementalState | null
  pending: NodeJS.Timeout | null
  pendingCause: 'native' | 'full' | null
  loading: boolean
  // loading 期间又来了新事件 → 标记,跑完再跑一次。
  staleAfterLoad: boolean
}

const entries = new Map<string, Entry>()

function keyOf(source: Source, id: string): string {
  return `${source}:${id}`
}

async function statNative(filePath: string): Promise<{ size: number; inode?: number } | null> {
  try {
    const st = await fsp.stat(filePath)
    return { size: st.size, inode: st.ino }
  } catch {
    return null
  }
}

async function rebuildIncrementalState(source: Source, filePath: string): Promise<JsonlIncrementalState | null> {
  const loader = loaderBySource.get(source)
  if (!loader?.loadEventsFrom) return null
  const st = await statNative(filePath)
  if (!st) return null
  const result = await loader.loadEventsFrom(filePath, {
    byteOffset: 0,
    lineNo: 0,
    seq: 0,
    inode: st.inode,
  })
  return { ...result.state, inode: st.inode }
}

async function tryIncrementalNativeAppend(
  source: Source,
  filePath: string,
  entry: Entry,
): Promise<'handled' | 'fallback'> {
  const loader = loaderBySource.get(source)
  if (!loader?.loadEventsFrom || !entry.incremental) return 'fallback'
  if (entry.lastTotal === -1 || entry.lastNativeTotal === -1) return 'fallback'
  // 有 followup_boundary 时 native 追加会落在 assemble 后的中段,继续走全量 reset 语义。
  if (entry.lastTotal !== entry.lastNativeTotal) return 'fallback'
  // 全量 loader 会按既有宽容语义读 EOF 无换行行;若初始化时有 pending,增量提交会重复该行。
  if (entry.incremental.pending) return 'fallback'

  const st = await statNative(filePath)
  if (!st) return 'fallback'
  if (entry.incremental.inode != null && st.inode != null && entry.incremental.inode !== st.inode) {
    entry.incremental = null
    return 'fallback'
  }
  if (st.size < entry.incremental.byteOffset) {
    entry.incremental = null
    broadcast(entry, { kind: 'reset', reason: 'truncated' })
    return 'handled'
  }

  const result = await loader.loadEventsFrom(filePath, entry.incremental)
  entry.incremental = { ...result.state, inode: st.inode }
  if (result.events.length === 0) return 'handled'

  entry.lastTotal += result.events.length
  entry.lastNativeTotal += result.events.length
  broadcast(entry, { kind: 'append', total: entry.lastTotal, newEvents: result.events })
  return 'handled'
}

async function reload(source: Source, id: string, filePath: string, entry: Entry, cause: 'native' | 'full' = 'full') {
  if (entry.loading) {
    entry.staleAfterLoad = true
    entry.pendingCause = cause === 'native' && entry.pendingCause !== 'full' ? 'native' : 'full'
    return
  }
  entry.loading = true
  try {
    if (cause === 'native') {
      const handled = await tryIncrementalNativeAppend(source, filePath, entry)
      if (handled === 'handled') return
    }

    const detail = await loadSessionDetail(source, id, filePath)
    const events = detail?.events ?? []
    const total = events.length
    const boundaryIdx = events.findIndex((e) => e.event.type === 'followup_boundary')
    const nativeTotal = boundaryIdx === -1 ? total : boundaryIdx

    const first = entry.lastTotal === -1
    const prevTotal = entry.lastTotal
    const prevNativeTotal = entry.lastNativeTotal

    entry.lastTotal = total
    entry.lastNativeTotal = nativeTotal
    entry.incremental = boundaryIdx === -1 ? await rebuildIncrementalState(source, filePath) : null

    if (first) {
      // 第一次加载由订阅时的 catch-up 路径处理,不通过 watcher 推。
      return
    }

    // 中段插入:boundary 前 native 长度变了,尾部增量不成立。
    if (prevNativeTotal !== -1 && nativeTotal !== prevNativeTotal && boundaryIdx !== -1) {
      broadcast(entry, { kind: 'reset', reason: 'native-middle-insert' })
      return
    }

    // 截断/重写。
    if (total < prevTotal) {
      broadcast(entry, { kind: 'reset', reason: 'truncated' })
      return
    }

    if (total > prevTotal) {
      const newEvents = events.slice(prevTotal)
      broadcast(entry, { kind: 'append', total, newEvents })
    }
  } catch {
    broadcast(entry, { kind: 'reset', reason: 'load-error' })
  } finally {
    entry.loading = false
    if (entry.staleAfterLoad) {
      entry.staleAfterLoad = false
      // 异步触发一次再跑,避免递归。
      const nextCause = entry.pendingCause ?? 'full'
      entry.pendingCause = null
      setTimeout(() => reload(source, id, filePath, entry, nextCause), 0)
    }
  }
}

function broadcast(entry: Entry, msg: WatcherUpdate) {
  for (const l of entry.refs) {
    try {
      l(msg)
    } catch {
      /* 单个 listener 抛错不影响其他 */
    }
  }
}

function schedule(source: Source, id: string, filePath: string, entry: Entry, cause: 'native' | 'full' = 'full') {
  if (entry.pending) {
    if (cause !== 'native') entry.pendingCause = 'full'
    return
  }
  entry.pendingCause = cause
  entry.pending = setTimeout(() => {
    entry.pending = null
    const nextCause = entry.pendingCause ?? 'full'
    entry.pendingCause = null
    reload(source, id, filePath, entry, nextCause)
  }, 50)
}

function tryWatch(path: string, onChange: () => void, onLost: () => void): fs.FSWatcher | null {
  try {
    // recursive:false,只看单个文件;persistent:false 避免阻挡进程退出。
    const w = fs.watch(path, { persistent: false }, () => onChange())
    w.on('error', () => {
      // 文件被删/换 inode:关闭并通知上层重建(docs/12 F2)。
      try {
        w.close()
      } catch {
        /* ignore */
      }
      onLost()
    })
    return w
  } catch {
    // 文件还不存在(原生 session 刚开始 / 还没有 follow-up),由上层周期性补建。
    return null
  }
}

const REBUILD_INTERVAL_MS = 2000

// 确保两个 watcher 就位;建不齐(文件尚不存在)则周期性重试。
// 新建成功时触发一次 reload,补上 watch 建立前已写入的内容。
function ensureWatchers(source: Source, id: string, filePath: string, entry: Entry) {
  const onNativeChange = () => schedule(source, id, filePath, entry, 'native')
  const onFollowupChange = () => schedule(source, id, filePath, entry, 'full')
  let created = false
  if (!entry.nativeWatcher) {
    entry.nativeWatcher = tryWatch(filePath, onNativeChange, () => {
      entry.nativeWatcher = null
      entry.incremental = null
      ensureWatchers(source, id, filePath, entry)
    })
    created ||= entry.nativeWatcher != null
  }
  if (!entry.followupWatcher) {
    entry.followupWatcher = tryWatch(followupsFile(source, id), onFollowupChange, () => {
      entry.followupWatcher = null
      ensureWatchers(source, id, filePath, entry)
    })
    created ||= entry.followupWatcher != null
  }
  if (created) schedule(source, id, filePath, entry, 'full')

  if (entry.nativeWatcher && entry.followupWatcher) {
    if (entry.rebuildTimer) {
      clearTimeout(entry.rebuildTimer)
      entry.rebuildTimer = null
    }
    return
  }
  if (entry.rebuildTimer || entry.refs.size === 0) return
  entry.rebuildTimer = setTimeout(() => {
    entry.rebuildTimer = null
    if (entry.refs.size > 0) ensureWatchers(source, id, filePath, entry)
  }, REBUILD_INTERVAL_MS)
  entry.rebuildTimer.unref?.()
}

export function subscribe(
  source: Source,
  id: string,
  filePath: string,
  listener: WatcherListener,
): () => void {
  const key = keyOf(source, id)
  let entry = entries.get(key)
  const isNew = !entry
  if (!entry) {
    entry = {
      refs: new Set(),
      nativeWatcher: null,
      followupWatcher: null,
      rebuildTimer: null,
      lastTotal: -1,
      lastNativeTotal: -1,
      incremental: null,
      pending: null,
      pendingCause: null,
      loading: false,
      staleAfterLoad: false,
    }
    entries.set(key, entry)
  }

  entry.refs.add(listener)

  if (isNew) {
    ensureWatchers(source, id, filePath, entry)

    // 首次加载 → 用于初始化 lastTotal / lastNativeTotal。不广播。
    reload(source, id, filePath, entry, 'full').catch(() => {
      /* 已在 reload 内部处理 */
    })
  }

  return () => {
    if (!entry) return
    entry.refs.delete(listener)
    if (entry.refs.size === 0) {
      entries.delete(key)
      if (entry.pending) clearTimeout(entry.pending)
      if (entry.rebuildTimer) clearTimeout(entry.rebuildTimer)
      try {
        entry.nativeWatcher?.close()
      } catch {
        /* ignore */
      }
      try {
        entry.followupWatcher?.close()
      } catch {
        /* ignore */
      }
    }
  }
}

/** 仅用于测试 / 诊断。 */
export function _watcherStats() {
  return {
    sessions: entries.size,
    totalRefs: [...entries.values()].reduce((n, e) => n + e.refs.size, 0),
  }
}
