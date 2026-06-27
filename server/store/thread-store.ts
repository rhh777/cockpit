import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { readJsonlLines } from '../util/jsonl'
import type { EventEnvelope, NormalizedEvent, Source } from '../loaders/types'
import { followupsFile, threadDir } from './paths'

// cockpit follow-up 读写。持久化格式见 docs/01 §八:每行一个扁平 JSON
// (origin/source/turnId/runId + NormalizedEvent 字段平铺)。append-only,崩溃半截也保留。

const TOP_KEYS = ['origin', 'source', 'sourceEventId', 'parentEventId', 'turnId', 'runId'] as const

function flatLine(env: EventEnvelope): string {
  const flat: Record<string, unknown> = {
    origin: env.origin,
    source: env.source,
    sourceEventId: env.sourceEventId,
    parentEventId: env.parentEventId,
    turnId: env.turnId,
    runId: env.runId,
    ...env.event, // type / ts / text / agent / ... 平铺到顶层
  }
  for (const k of Object.keys(flat)) if (flat[k] === undefined) delete flat[k]
  return JSON.stringify(flat) + '\n'
}

function envelopeFromFlatLine(o: Record<string, unknown>, source: Source): EventEnvelope | null {
  const rest: Record<string, unknown> = { ...o }
  for (const k of TOP_KEYS) delete rest[k]
  if (typeof rest.type !== 'string') return null
  return {
    origin: 'cockpit',
    source,
    sourceEventId: typeof o.sourceEventId === 'string' ? o.sourceEventId : undefined,
    parentEventId: typeof o.parentEventId === 'string' ? o.parentEventId : undefined,
    turnId: typeof o.turnId === 'string' ? o.turnId : undefined,
    runId: typeof o.runId === 'string' ? o.runId : undefined,
    event: rest as unknown as NormalizedEvent,
  }
}

// 每个 session 一个串行 append 队列(风险表:append 严格单进程内串行,防并发写损坏)。
const queues = new Map<string, Promise<void>>()

function enqueue(key: string, task: () => Promise<void>): Promise<void> {
  const prev = queues.get(key) ?? Promise.resolve()
  const next = prev.then(task, task) // 前一个失败也继续,保证队列不卡死
  queues.set(
    key,
    next.catch(() => {}),
  )
  return next
}

export type TurnStatus = 'completed' | 'aborted' | 'failed'

export const threadStore = {
  hasFollowups(source: Source, id: string): boolean {
    try {
      return fs.statSync(followupsFile(source, id)).size > 0
    } catch {
      return false
    }
  },

  async readFollowups(source: Source, id: string): Promise<EventEnvelope[]> {
    const file = followupsFile(source, id)
    if (!fs.existsSync(file)) return []
    const out: EventEnvelope[] = []
    for await (const { parsed } of readJsonlLines(file)) {
      if (parsed === undefined) continue // best-effort:崩溃半截行跳过
      const env = envelopeFromFlatLine(parsed as Record<string, unknown>, source)
      if (env) out.push(env)
    }
    return out
  },

  // 原子 append,经串行队列。首次写前建目录。
  appendEvent(source: Source, id: string, env: EventEnvelope): Promise<void> {
    const key = `${source}:${id}`
    const file = followupsFile(source, id)
    return enqueue(key, async () => {
      await fsp.mkdir(threadDir(source, id), { recursive: true })
      await fsp.appendFile(file, flatLine(env), 'utf8')
    })
  },

  // 终态:完成/取消/失败都要落 turn_status,否则 UI 无法区分"在生成"与"半截终止"。
  appendTurnStatus(
    source: Source,
    id: string,
    turnId: string,
    runId: string,
    status: TurnStatus,
    error?: string,
  ): Promise<void> {
    return this.appendEvent(source, id, {
      origin: 'cockpit',
      source,
      sourceEventId: `status:${turnId}:${status}`,
      turnId,
      runId,
      event: {
        type: 'meta',
        key: 'turn_status',
        value: error ? { status, error } : { status },
        ts: new Date().toISOString(),
      },
    })
  },

  async clearFollowups(source: Source, id: string): Promise<void> {
    const key = `${source}:${id}`
    await enqueue(key, async () => {
      await fsp.rm(followupsFile(source, id), { force: true })
    })
  },

  async deleteTurn(source: Source, id: string, turnId: string): Promise<void> {
    // 删除某一轮:重写文件,滤掉该 turnId 的所有事件(口子,支持失败轮重试)。
    const key = `${source}:${id}`
    await enqueue(key, async () => {
      const events = await threadStore.readFollowups(source, id)
      const kept = events.filter((e) => e.turnId !== turnId)
      const file = followupsFile(source, id)
      if (kept.length === 0) {
        await fsp.rm(file, { force: true })
        return
      }
      const tmp = file + '.tmp'
      await fsp.writeFile(tmp, kept.map(flatLine).join(''), 'utf8')
      await fsp.rename(tmp, file)
    })
  },
}

export const _internal = { flatLine, envelopeFromFlatLine, dir: threadDir, file: path.basename }
