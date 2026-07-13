import fsp from 'node:fs/promises'
import type { EventEnvelope, Source } from './loaders/types'
import { followupsFile } from './store/paths'
import { loadSessionDetail } from './sessions-service'

// 游标式增量(docs/01 §五流程 C,不变量 11/12)。
// 只回第 N 条之后的事件,不回整个 SessionDetail。
export interface ChangesResult {
  changed: boolean
  total: number
  newEvents: EventEnvelope[]
  reset?: boolean // true = 让前端全量重载(中段插入,无法走尾部增量)
}

interface CacheEntry {
  sig: string
  total: number
  nativeTotal: number
}

// 用 mtime/size 快速判断是否变化,未变则不重新解析(MB 级文件每 2s 不能全量重读)。
const cache = new Map<string, CacheEntry>()

async function statSig(filePath: string): Promise<string> {
  try {
    const s = await fsp.stat(filePath)
    return `${s.mtimeMs}:${s.size}`
  } catch {
    return '0:0' // 文件不存在(如 cockpit 自建 thread 无原始文件)
  }
}

async function nativeStatSig(source: Source, filePath: string): Promise<string> {
  const base = await statSig(filePath)
  // OpenCode uses SQLite WAL mode; native writes may change only sidecar files until a
  // checkpoint updates opencode.db itself.
  if (source === 'opencode') {
    return `${base}|wal:${await statSig(`${filePath}-wal`)}|shm:${await statSig(`${filePath}-shm`)}`
  }
  return base
}

export async function getChanges(
  source: Source,
  id: string,
  filePath: string,
  sinceEventCount: number,
): Promise<ChangesResult> {
  const key = `${source}:${id}`
  // 原始文件 + follow-up 文件任一变化都要重读。
  const sig = `${await nativeStatSig(source, filePath)}|${await statSig(followupsFile(source, id))}`

  const cached = cache.get(key)
  if (cached && cached.sig === sig) {
    return { changed: false, total: cached.total, newEvents: [] }
  }

  const detail = await loadSessionDetail(source, id, filePath)
  const events = detail?.events ?? []
  const total = events.length

  // 合并列表是 [native..., boundary, followup...]。尾部增量只在「列表末尾追加」时成立:
  //  - 无 followup:native 在末尾追加 → 安全。
  //  - 有 followup:只有 followup 增长(末尾)安全;native 增长是中段插入 → 必须 reset。
  // 这与不变量 11(各来源内按行序、只在 boundary 处拼接)一致。
  const boundaryIdx = events.findIndex((e) => e.event.type === 'followup_boundary')
  const hasFollowup = boundaryIdx !== -1
  const nativeTotal = hasFollowup ? boundaryIdx : total

  const prev = cached
  cache.set(key, { sig, total, nativeTotal })

  if (prev && hasFollowup && prev.nativeTotal !== nativeTotal) {
    return { changed: true, reset: true, total, newEvents: [] }
  }

  // since>total(文件被截断/重写)时回空,前端据 total<since 回退全量 GET。
  const newEvents =
    sinceEventCount >= 0 && sinceEventCount <= total ? events.slice(sinceEventCount) : []
  return { changed: true, reset: false, total, newEvents }
}
