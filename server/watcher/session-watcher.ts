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
import type { EventEnvelope, Source } from '../loaders/types'
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
  pending: NodeJS.Timeout | null
  loading: boolean
  // loading 期间又来了新事件 → 标记,跑完再跑一次。
  staleAfterLoad: boolean
}

const entries = new Map<string, Entry>()

function keyOf(source: Source, id: string): string {
  return `${source}:${id}`
}

async function reload(source: Source, id: string, filePath: string, entry: Entry) {
  if (entry.loading) {
    entry.staleAfterLoad = true
    return
  }
  entry.loading = true
  try {
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
      setTimeout(() => reload(source, id, filePath, entry), 0)
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

function schedule(source: Source, id: string, filePath: string, entry: Entry) {
  if (entry.pending) return
  entry.pending = setTimeout(() => {
    entry.pending = null
    reload(source, id, filePath, entry)
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
  const onChange = () => schedule(source, id, filePath, entry)
  let created = false
  if (!entry.nativeWatcher) {
    entry.nativeWatcher = tryWatch(filePath, onChange, () => {
      entry.nativeWatcher = null
      ensureWatchers(source, id, filePath, entry)
    })
    created ||= entry.nativeWatcher != null
  }
  if (!entry.followupWatcher) {
    entry.followupWatcher = tryWatch(followupsFile(source, id), onChange, () => {
      entry.followupWatcher = null
      ensureWatchers(source, id, filePath, entry)
    })
    created ||= entry.followupWatcher != null
  }
  if (created) schedule(source, id, filePath, entry)

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
      pending: null,
      loading: false,
      staleAfterLoad: false,
    }
    entries.set(key, entry)
  }

  entry.refs.add(listener)

  if (isNew) {
    ensureWatchers(source, id, filePath, entry)

    // 首次加载 → 用于初始化 lastTotal / lastNativeTotal。不广播。
    reload(source, id, filePath, entry).catch(() => {
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
