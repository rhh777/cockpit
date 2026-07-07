import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { COCKPIT_RUNTIME_LINKS_ROOT } from '../config'
import type { AgentName, Source } from '../loaders/types'

// Phase 2 —— provider-thread link 缓存。
//
// 语义(见 docs/11 §Phase 2):
// - Cockpit follow-up 默认 ephemeral 不落 provider thread;用户 opt-in「加速模式」后才建立 link。
// - link 记录 Cockpit scope ↔ 原生 provider thread id 的映射,让下一轮直接 `turn/start(existingThreadId)`。
// - link 是 Cockpit-owned 缓存,不是事实源:任何 fingerprint 变化都可以 stale + 重建。
// - link 存在 = 用户已知悉「本 thread 会通过官方 runtime 产生原生 session 副作用」。
//
// 存储:`~/.cockpit/runtime-links/codex.jsonl`(小文件,一 scope 一 link,全量重写更新)。

export type LinkPersistence = 'ephemeral' | 'native-linked'
export type LinkStatus = 'active' | 'stale' | 'failed'

export interface FollowupScope {
  kind: 'followup'
  source: Source
  sessionId: string
  agent: AgentName
}
export interface GroupMemberScope {
  kind: 'group-member'
  groupThreadId: string
  agent: AgentName
}
export type CockpitScope = FollowupScope | GroupMemberScope

export interface LinkThreadKey {
  cwd: string | null
  model?: string
  effort?: string
  permissionMode?: string
  writableRoots?: string[]
}

export interface ProviderThreadLink {
  id: string
  provider: 'codex' | 'claude'
  cockpitScope: CockpitScope
  threadKeyHash: string
  nativeThreadId: string
  persistence: LinkPersistence
  createdAt: string
  updatedAt: string
  sourceFingerprint: {
    eventCount: number
    latestTurnId?: string
    summaryRevision?: number
  }
  status: LinkStatus
}

// scope 的字符串键。同一 Cockpit scope 全局只保留一条 active link。
export function scopeKey(scope: CockpitScope): string {
  if (scope.kind === 'followup') {
    return `followup:${scope.source}:${scope.sessionId}:${scope.agent}`
  }
  return `group-member:${scope.groupThreadId}:${scope.agent}`
}

// 权限/上下文变化 → threadKeyHash 变化 → 旧 link stale。
// 只做稳定序列化 + sha256;不包含 provider 无关字段(sessionId 属于 scope 层)。
export function hashThreadKey(key: LinkThreadKey): string {
  const stable = {
    cwd: key.cwd ?? '',
    model: key.model ?? '',
    effort: key.effort ?? '',
    permissionMode: key.permissionMode ?? '',
    writableRoots: [...(key.writableRoots ?? [])].sort(),
  }
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 32)
}

function linkFile(provider: 'codex' | 'claude'): string {
  return path.join(COCKPIT_RUNTIME_LINKS_ROOT, `${provider}.jsonl`)
}

async function readAllRaw(provider: 'codex' | 'claude'): Promise<ProviderThreadLink[]> {
  const file = linkFile(provider)
  if (!fs.existsSync(file)) return []
  try {
    const raw = await fsp.readFile(file, 'utf8')
    const out: ProviderThreadLink[] = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed) as ProviderThreadLink
        if (parsed && typeof parsed.id === 'string' && parsed.provider === provider) out.push(parsed)
      } catch {
        // 坏行跳过,best-effort。
      }
    }
    return out
  } catch {
    return []
  }
}

async function atomicWriteAll(provider: 'codex' | 'claude', links: ProviderThreadLink[]): Promise<void> {
  await fsp.mkdir(COCKPIT_RUNTIME_LINKS_ROOT, { recursive: true })
  const file = linkFile(provider)
  const tmp = `${file}.tmp`
  const body = links.map((l) => JSON.stringify(l)).join('\n') + (links.length > 0 ? '\n' : '')
  await fsp.writeFile(tmp, body, 'utf8')
  await fsp.rename(tmp, file)
}

// 全局串行:写文件不能并发。
let queue: Promise<void> = Promise.resolve()
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task) as Promise<T>
  queue = next.then(
    () => {},
    () => {},
  )
  return next
}

export interface UpsertLinkInput {
  provider: 'codex' | 'claude'
  scope: CockpitScope
  threadKey: LinkThreadKey
  nativeThreadId: string
  persistence: LinkPersistence
  sourceFingerprint: ProviderThreadLink['sourceFingerprint']
}

export const providerThreadLinkStore = {
  async findActive(
    provider: 'codex' | 'claude',
    scope: CockpitScope,
    threadKey: LinkThreadKey,
  ): Promise<ProviderThreadLink | null> {
    const links = await readAllRaw(provider)
    const target = scopeKey(scope)
    const hash = hashThreadKey(threadKey)
    for (const l of links) {
      if (l.status !== 'active') continue
      if (scopeKey(l.cockpitScope) !== target) continue
      if (l.threadKeyHash !== hash) continue
      return l
    }
    return null
  },

  async upsert(input: UpsertLinkInput): Promise<ProviderThreadLink> {
    return enqueue(async () => {
      const links = await readAllRaw(input.provider)
      const targetScope = scopeKey(input.scope)
      const hash = hashThreadKey(input.threadKey)
      const now = new Date().toISOString()

      // 同 scope 不同 threadKey 的旧 link 立刻 stale(权限/model/cwd 变了就换 thread)。
      for (const l of links) {
        if (scopeKey(l.cockpitScope) === targetScope && l.threadKeyHash !== hash && l.status === 'active') {
          l.status = 'stale'
          l.updatedAt = now
        }
      }

      const existing = links.find(
        (l) => scopeKey(l.cockpitScope) === targetScope && l.threadKeyHash === hash,
      )
      let result: ProviderThreadLink
      if (existing) {
        existing.nativeThreadId = input.nativeThreadId
        existing.persistence = input.persistence
        existing.sourceFingerprint = input.sourceFingerprint
        existing.status = 'active'
        existing.updatedAt = now
        result = existing
      } else {
        result = {
          id: `link_${crypto.randomUUID()}`,
          provider: input.provider,
          cockpitScope: input.scope,
          threadKeyHash: hash,
          nativeThreadId: input.nativeThreadId,
          persistence: input.persistence,
          createdAt: now,
          updatedAt: now,
          sourceFingerprint: input.sourceFingerprint,
          status: 'active',
        }
        links.push(result)
      }
      await atomicWriteAll(input.provider, links)
      return result
    })
  },

  async markStatus(
    provider: 'codex' | 'claude',
    linkId: string,
    status: LinkStatus,
  ): Promise<void> {
    await enqueue(async () => {
      const links = await readAllRaw(provider)
      const target = links.find((l) => l.id === linkId)
      if (!target) return
      target.status = status
      target.updatedAt = new Date().toISOString()
      await atomicWriteAll(provider, links)
    })
  },

  async removeScope(provider: 'codex' | 'claude', scope: CockpitScope): Promise<void> {
    await enqueue(async () => {
      const links = await readAllRaw(provider)
      const target = scopeKey(scope)
      const remaining = links.filter((l) => scopeKey(l.cockpitScope) !== target)
      if (remaining.length === links.length) return
      await atomicWriteAll(provider, remaining)
    })
  },

  // 测试口子。生产不用。
  async _readAll(provider: 'codex' | 'claude'): Promise<ProviderThreadLink[]> {
    return readAllRaw(provider)
  },
}
