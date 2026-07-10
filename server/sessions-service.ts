import fsp from 'node:fs/promises'
import { loaderBySource } from './loaders'
import type { EventEnvelope, SessionDetail, SessionSummary, Source } from './loaders/types'
import { sessionRegistry } from './registry/session-registry'
import { threadStore } from './store/thread-store'
import { cleanTitle } from './util/title'

type NativeLoadResult = { summaryPatch: Partial<SessionSummary>; events: EventEnvelope[]; warnings: any[] }

// 原生解析缓存(docs/12 F1):watcher 全量路径仍会重读 detail;follow-up 流式期间
// 变的是 followups.jsonl,原生大文件没动——按 (mtimeMs, size) 命中即复用上次解析结果。
// 约定:所有消费方只读不改 events 数组与 envelope(现有代码均为 copy-on-use)。
// 原生文件自身追加的 watcher 热路径另走 session-watcher 的 byte-offset 增量。
const nativeParseCache = new Map<string, { mtimeMs: number; size: number; result: NativeLoadResult }>()
const NATIVE_PARSE_CACHE_MAX = 8

// 合并:[...原始 native, followup_boundary, ...follow-up cockpit]。
// 永不按 ts 全局重排;只在 boundary 处拼接(不变量 11)。
export async function loadSessionDetail(
  source: Source,
  id: string,
  filePath: string,
): Promise<SessionDetail | null> {
  const loader = loaderBySource.get(source)
  if (!loader) return null

  let preStat: { mtimeMs: number; size: number } | null = null
  try {
    const s = await fsp.stat(filePath)
    preStat = { mtimeMs: s.mtimeMs, size: s.size }
  } catch {
    /* cockpit 自建 thread 无原始文件;不缓存 */
  }

  const cached = preStat ? nativeParseCache.get(filePath) : undefined
  let native: NativeLoadResult
  if (cached && preStat && cached.mtimeMs === preStat.mtimeMs && cached.size === preStat.size) {
    nativeParseCache.delete(filePath) // LRU:命中挪到队尾
    nativeParseCache.set(filePath, cached)
    native = cached.result
  } else {
    native = await loader.loadEvents(filePath)
    if (preStat) {
      nativeParseCache.set(filePath, { ...preStat, result: native })
      while (nativeParseCache.size > NATIVE_PARSE_CACHE_MAX) {
        const oldest = nativeParseCache.keys().next().value
        if (oldest === undefined) break
        nativeParseCache.delete(oldest)
      }
    }
  }

  const followups = source === 'cockpit' ? [] : await threadStore.readFollowups(source, id)

  const events: EventEnvelope[] = [...native.events]
  if (followups.length > 0) {
    const boundaryTs = followups[0]?.event.ts ?? new Date().toISOString()
    events.push({
      origin: 'cockpit',
      source,
      sourceEventId: `boundary:${source}:${id}`, // 稳定 id,供前端去重(不变量 12)
      event: { type: 'followup_boundary', ts: boundaryTs },
    })
    events.push(...followups)
  }

  const st = preStat ?? { mtimeMs: 0, size: 0 }

  // updatedAt 同列表口径:原生 mtime 与 followups mtime 取较新者(docs/12 G4)。
  const followupMtime = followups.length > 0 ? threadStore.followupsMtimeMs(source, id) : null
  const updatedMs = Math.max(st.mtimeMs, followupMtime ?? 0)
  const summary: SessionSummary = {
    id,
    source,
    title: '',
    cwd: native.summaryPatch.cwd ?? null,
    startedAt: native.summaryPatch.startedAt ?? new Date(st.mtimeMs).toISOString(),
    updatedAt: new Date(updatedMs).toISOString(),
    messageCount: native.summaryPatch.messageCount ?? null,
    filePath,
    fileMtimeMs: st.mtimeMs,
    fileSize: st.size,
    hasFollowups: followups.length > 0,
    ...native.summaryPatch,
  }
  // title 从首条 user_text 兜底
  if (!summary.title) {
    const firstUser = events.find((e) => e.event.type === 'user_text')
    summary.title =
      firstUser && firstUser.event.type === 'user_text'
        ? (cleanTitle(firstUser.event.text) || '(无标题)')
        : '(无标题)'
  }

  return {
    summary,
    events,
    warnings: native.warnings,
  }
}

// 列表:registry 出摘要 + threadStore 回填 hasFollowups / updatedAt。
export async function listSessions(): Promise<SessionSummary[]> {
  const summaries = await sessionRegistry.discoverAll()
  for (const s of summaries) {
    s.hasFollowups = threadStore.hasFollowups(s.source, s.id)
    // updatedAt 取原生 mtime 与 followups mtime 的较新者,让 cockpit 活动也能
    // 把 session 顶到「今天」分组(docs/12 G4)。
    if (s.hasFollowups) {
      const fm = threadStore.followupsMtimeMs(s.source, s.id)
      if (fm != null && fm > new Date(s.updatedAt).getTime()) {
        s.updatedAt = new Date(fm).toISOString()
      }
    }
  }
  return summaries
}
