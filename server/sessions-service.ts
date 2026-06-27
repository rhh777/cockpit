import fsp from 'node:fs/promises'
import { loaderBySource } from './loaders'
import type { EventEnvelope, SessionDetail, SessionSummary, Source } from './loaders/types'
import { sessionRegistry } from './registry/session-registry'
import { threadStore } from './store/thread-store'
import { cleanTitle } from './util/title'

// 合并:[...原始 native, followup_boundary, ...follow-up cockpit]。
// 永不按 ts 全局重排;只在 boundary 处拼接(不变量 11)。
export async function loadSessionDetail(
  source: Source,
  id: string,
  filePath: string,
): Promise<SessionDetail | null> {
  const loader = loaderBySource.get(source)
  if (!loader) return null

  const native: { summaryPatch: Partial<SessionSummary>; events: EventEnvelope[]; warnings: any[] } =
    await loader.loadEvents(filePath)

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

  let st: { mtimeMs: number; size: number } = { mtimeMs: 0, size: 0 }
  try {
    const s = await fsp.stat(filePath)
    st = { mtimeMs: s.mtimeMs, size: s.size }
  } catch {
    /* cockpit 自建 thread 无原始文件 */
  }

  const summary: SessionSummary = {
    id,
    source,
    title: '',
    cwd: native.summaryPatch.cwd ?? null,
    startedAt: native.summaryPatch.startedAt ?? new Date(st.mtimeMs).toISOString(),
    updatedAt: new Date(st.mtimeMs).toISOString(),
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

// 列表:registry 出摘要 + threadStore 回填 hasFollowups。
export async function listSessions(): Promise<SessionSummary[]> {
  const summaries = await sessionRegistry.discoverAll()
  for (const s of summaries) {
    s.hasFollowups = threadStore.hasFollowups(s.source, s.id)
  }
  return summaries
}
