import type { Source } from '../loaders/types'
import { loadSessionDetail } from '../sessions-service'
import { threadContextStore } from '../store/thread-context-store'
import { CONTEXT_STATE_VERSION, type ThreadContextState } from '../store/thread-context-store'
import { getSummaryGenerator } from './summary-generator'

// 每轮结束后异步刷新 summary + context-state。
//
// - fire-and-forget:不 await,不阻塞 SSE 返回;失败静默(只写 warning 日志)。
// - checkpoint 记 `upToSourceEventId` = 原生段最后一条真实事件的 sourceEventId,后续 projector 用它切分。
// - summaryRevision 每次成功刷新自增,给 [[provider-thread-link]] 做失效比对留口子。

// 最小事件门槛;不到这个数不生成 summary(短 session 走 full context 已足够)。
const MIN_EVENTS_FOR_SUMMARY = 20

const inflight = new Set<string>()

export function scheduleSummaryRefresh(source: Source, id: string, filePath: string): void {
  const key = `${source}:${id}`
  if (inflight.has(key)) return
  inflight.add(key)
  // 微任务里跑,让当前 SSE 响应先返回。
  queueMicrotask(async () => {
    try {
      await refreshSummaryOnce(source, id, filePath)
    } catch (err) {
      // 只降级,不上抛。summary 缺失只影响下一轮走 full,不影响正确性。
      // eslint-disable-next-line no-console
      console.warn(`[summary-refresh] ${key} failed:`, err)
    } finally {
      inflight.delete(key)
    }
  })
}

export async function refreshSummaryOnce(
  source: Source,
  id: string,
  filePath: string,
): Promise<void> {
  const detail = await loadSessionDetail(source, id, filePath)
  if (!detail) return
  const events = detail.events

  // 原生段太短不划算,跳过。
  const boundaryIdx = events.findIndex((e) => e.event.type === 'followup_boundary')
  const nativeCount = boundaryIdx === -1 ? events.length : boundaryIdx
  if (nativeCount < MIN_EVENTS_FOR_SUMMARY) return

  const prior = await threadContextStore.readState(source, id)
  const priorSummary = prior ? await threadContextStore.readSummary(source, id) : null

  // 原生段大小没涨且已有 summary,不重复算。
  if (
    prior &&
    priorSummary &&
    prior.checkpoint.sourceEventCount === nativeCount
  ) {
    return
  }

  const out = await getSummaryGenerator().generate({
    sourceId: id,
    events,
    priorSummary: priorSummary ?? undefined,
  })
  if (!out.markdown || !out.anchorSourceEventId) return

  const nextRevision = (prior?.checkpoint.summaryRevision ?? 0) + 1
  const state: ThreadContextState = {
    version: CONTEXT_STATE_VERSION,
    checkpoint: {
      upToSourceEventId: out.anchorSourceEventId,
      sourceEventCount: out.nativeEventCount,
      summaryRevision: nextRevision,
      updatedAt: new Date().toISOString(),
    },
  }
  await threadContextStore.writeSummary(source, id, out.markdown)
  await threadContextStore.writeState(source, id, state)
}
