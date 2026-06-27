import { loaders } from '../loaders'
import type { SessionSummary, Source } from '../loaders/types'

// source:id → filePath 映射 + 列表缓存。详情页优先走 registry,避免每次扫盘(docs/01 §四)。
// 原生 JSONL 永远是事实来源,这里只是可重建缓存。

interface RegistryState {
  summaries: SessionSummary[]
  pathByKey: Map<string, string> // `${source}:${id}` → filePath
  builtAt: number
}

let state: RegistryState | null = null
let building: Promise<RegistryState> | null = null

const TTL_MS = 5_000 // discoverAll 结果短期复用,避免列表页连点重复全盘扫描

function key(source: Source, id: string): string {
  return `${source}:${id}`
}

async function build(): Promise<RegistryState> {
  const summaries: SessionSummary[] = []
  const pathByKey = new Map<string, string>()
  for (const loader of loaders) {
    try {
      const { summaries: s } = await loader.discover()
      for (const sum of s) {
        summaries.push(sum)
        pathByKey.set(key(sum.source, sum.id), sum.filePath)
      }
    } catch {
      // 单个来源失败不影响其它来源
    }
  }
  // mtime 倒序(docs/03 验收标准 1)
  summaries.sort((a, b) => b.fileMtimeMs - a.fileMtimeMs)
  return { summaries, pathByKey, builtAt: Date.now() }
}

async function ensure(force = false): Promise<RegistryState> {
  if (!force && state && Date.now() - state.builtAt < TTL_MS) return state
  if (building) return building
  building = build().finally(() => {
    building = null
  })
  state = await building
  return state
}

export const sessionRegistry = {
  async discoverAll(force = false): Promise<SessionSummary[]> {
    const s = await ensure(force)
    return s.summaries
  },

  // registry miss 时 fallback 到强制重建一次(慢路径)。
  async resolve(source: Source, id: string): Promise<string | null> {
    let s = await ensure()
    let p = s.pathByKey.get(key(source, id))
    if (!p) {
      s = await ensure(true)
      p = s.pathByKey.get(key(source, id))
    }
    return p ?? null
  },

  invalidate(): void {
    state = null
  },
}
