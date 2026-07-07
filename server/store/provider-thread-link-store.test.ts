import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

// 覆盖 HOME 让 COCKPIT_RUNTIME_LINKS_ROOT 指向临时目录 —— 必须在 import store 之前设置。
const TMP = path.join(os.tmpdir(), `cockpit-link-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
process.env.HOME = TMP
process.env.USERPROFILE = TMP

const { providerThreadLinkStore, hashThreadKey, scopeKey } = await import('./provider-thread-link-store')
import type { FollowupScope } from './provider-thread-link-store'

const SCOPE: FollowupScope = {
  kind: 'followup',
  source: 'codex',
  sessionId: 'sess-1',
  agent: 'codex',
}

const BASE_KEY = { cwd: '/proj', model: 'gpt-5', effort: 'high', permissionMode: 'auto-safe', writableRoots: ['/proj'] }

before(async () => {
  await fsp.mkdir(TMP, { recursive: true })
})
after(async () => {
  await fsp.rm(TMP, { recursive: true, force: true })
})

test('hashThreadKey: 稳定且忽略 writableRoots 顺序', () => {
  const a = hashThreadKey({ cwd: '/p', writableRoots: ['/a', '/b'] })
  const b = hashThreadKey({ cwd: '/p', writableRoots: ['/b', '/a'] })
  assert.equal(a, b)
  const c = hashThreadKey({ cwd: '/p', writableRoots: ['/a', '/c'] })
  assert.notEqual(a, c)
})

test('scopeKey: followup / group-member 区分', () => {
  assert.equal(scopeKey(SCOPE), 'followup:codex:sess-1:codex')
  assert.equal(
    scopeKey({ kind: 'group-member', groupThreadId: 'g1', agent: 'codex' }),
    'group-member:g1:codex',
  )
})

test('upsert + findActive: 同 scope + key 返回同一条,更新 nativeThreadId', async () => {
  const first = await providerThreadLinkStore.upsert({
    provider: 'codex',
    scope: SCOPE,
    threadKey: BASE_KEY,
    nativeThreadId: 'thread-1',
    persistence: 'native-linked',
    sourceFingerprint: { eventCount: 5 },
  })
  const found = await providerThreadLinkStore.findActive('codex', SCOPE, BASE_KEY)
  assert.ok(found)
  assert.equal(found!.id, first.id)
  assert.equal(found!.nativeThreadId, 'thread-1')

  const updated = await providerThreadLinkStore.upsert({
    provider: 'codex',
    scope: SCOPE,
    threadKey: BASE_KEY,
    nativeThreadId: 'thread-1',
    persistence: 'native-linked',
    sourceFingerprint: { eventCount: 12 },
  })
  assert.equal(updated.id, first.id)
  assert.equal(updated.sourceFingerprint.eventCount, 12)
})

test('upsert: 同 scope 不同 threadKey → 旧 link stale,新建一条', async () => {
  const NEW_KEY = { ...BASE_KEY, model: 'gpt-5-fast' }
  const before = await providerThreadLinkStore.findActive('codex', SCOPE, BASE_KEY)
  assert.ok(before)

  const next = await providerThreadLinkStore.upsert({
    provider: 'codex',
    scope: SCOPE,
    threadKey: NEW_KEY,
    nativeThreadId: 'thread-2',
    persistence: 'native-linked',
    sourceFingerprint: { eventCount: 3 },
  })
  assert.notEqual(next.id, before!.id)
  // 旧 key 现在找不到 active。
  const oldActive = await providerThreadLinkStore.findActive('codex', SCOPE, BASE_KEY)
  assert.equal(oldActive, null)
  // 全量里旧那条应为 stale。
  const all = await providerThreadLinkStore._readAll('codex')
  const staled = all.find((l) => l.id === before!.id)
  assert.equal(staled?.status, 'stale')
})

test('markStatus + removeScope', async () => {
  const found = await providerThreadLinkStore.findActive('codex', SCOPE, { ...BASE_KEY, model: 'gpt-5-fast' })
  assert.ok(found)
  await providerThreadLinkStore.markStatus('codex', found!.id, 'failed')
  const all = await providerThreadLinkStore._readAll('codex')
  assert.equal(all.find((l) => l.id === found!.id)?.status, 'failed')

  await providerThreadLinkStore.removeScope('codex', SCOPE)
  const after = await providerThreadLinkStore._readAll('codex')
  assert.equal(after.length, 0)
})
