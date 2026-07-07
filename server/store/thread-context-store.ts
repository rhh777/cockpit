import fs from 'node:fs'
import fsp from 'node:fs/promises'
import type { Source } from '../loaders/types'
import { threadContextStateFile, threadDir, threadSummaryFile } from './paths'

// Phase 4 — 每个 follow-up thread 的滚动 summary + checkpoint。
// summary.md 是 agent 可读的自然语言摘要;context-state.json 记录到哪个 sourceEventId 已被摘要覆盖。
// 两个文件都是可删可重建的 Cockpit-owned 缓存,不是事实源;丢失只影响下一轮改回 full 上下文。

export const CONTEXT_STATE_VERSION = 1

export interface ThreadContextState {
  version: number
  checkpoint: {
    // 摘要已覆盖到的最后一条原生 sourceEventId(用于 projector 定位切分点)。
    upToSourceEventId?: string
    // 生成 summary 时的原生事件总数,变化说明有新原生事件写入,checkpoint 可能过期。
    sourceEventCount: number
    // 用于 [[provider-thread-link]] 失效比对;每次 summary 重写自增。
    summaryRevision: number
    updatedAt: string
  }
}

const queues = new Map<string, Promise<void>>()

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve()
  const next = prev.then(task, task)
  queues.set(
    key,
    next.then(
      () => {},
      () => {},
    ),
  )
  return next
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp`
  await fsp.writeFile(tmp, content, 'utf8')
  await fsp.rename(tmp, file)
}

export const threadContextStore = {
  async readState(source: Source, id: string): Promise<ThreadContextState | null> {
    const file = threadContextStateFile(source, id)
    if (!fs.existsSync(file)) return null
    try {
      const raw = await fsp.readFile(file, 'utf8')
      const parsed = JSON.parse(raw) as ThreadContextState
      if (parsed?.version !== CONTEXT_STATE_VERSION) return null
      if (!parsed.checkpoint || typeof parsed.checkpoint.summaryRevision !== 'number') return null
      return parsed
    } catch {
      // 坏文件降级为无 state;不阻塞主流程。
      return null
    }
  },

  async writeState(source: Source, id: string, state: ThreadContextState): Promise<void> {
    const key = `${source}:${id}`
    await enqueue(key, async () => {
      await fsp.mkdir(threadDir(source, id), { recursive: true })
      await atomicWrite(threadContextStateFile(source, id), JSON.stringify(state, null, 2))
    })
  },

  async readSummary(source: Source, id: string): Promise<string | null> {
    const file = threadSummaryFile(source, id)
    if (!fs.existsSync(file)) return null
    try {
      return await fsp.readFile(file, 'utf8')
    } catch {
      return null
    }
  },

  async writeSummary(source: Source, id: string, markdown: string): Promise<void> {
    const key = `${source}:${id}`
    await enqueue(key, async () => {
      await fsp.mkdir(threadDir(source, id), { recursive: true })
      await atomicWrite(threadSummaryFile(source, id), markdown)
    })
  },

  async clear(source: Source, id: string): Promise<void> {
    const key = `${source}:${id}`
    await enqueue(key, async () => {
      await fsp.rm(threadContextStateFile(source, id), { force: true })
      await fsp.rm(threadSummaryFile(source, id), { force: true })
    })
  },
}
