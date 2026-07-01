// E2E: 端到端跑一次 handoff + group-from-session 全链路。
// 建一个假的原生 claude session,把 cockpit middleware 挂到 http.Server 上,
// 走真 HTTP 调 /api/handoffs 和 /api/group-threads/from-session,验证:
// - 创建 handoff 落盘所有 markdown
// - GET handoff 返回 freshness=fresh
// - source 事件推进后再 GET 返回 freshness=stale
// - open-native (codex/claude) 返回预期形态
// - group-from-session 建群 + 导入事件

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { AddressInfo } from 'node:net'

const HOME = await fsp.mkdtemp(path.join(os.tmpdir(), 'cockpit-e2e-'))
process.env.HOME = HOME

// 造一个假的 claude-code session,让 registry 能发现它。
const CLAUDE_PROJ = path.join(HOME, '.claude', 'projects', '-tmp-e2e')
await fsp.mkdir(CLAUDE_PROJ, { recursive: true })
const SESSION_ID = 'e2e-sess-1'
const sessionFile = path.join(CLAUDE_PROJ, `${SESSION_ID}.jsonl`)

// docs/02: claude-code loader 只需要合法 JSONL 里能抽出 message + cwd。
const initialLines = [
  JSON.stringify({
    type: 'user',
    uuid: 'u1',
    cwd: '/tmp/e2e',
    timestamp: '2025-01-01T00:00:00Z',
    message: { role: 'user', content: [{ type: 'text', text: 'Please refactor login flow' }] },
  }),
  JSON.stringify({
    type: 'assistant',
    uuid: 'a1',
    timestamp: '2025-01-01T00:00:10Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Looking at the code now' }] },
  }),
]
await fsp.writeFile(sessionFile, initialLines.join('\n') + '\n', 'utf8')

const { cockpitApi } = await import('../index')

const server = http.createServer(async (req, res) => {
  await new Promise<void>((resolve) => {
    ;(cockpitApi() as (req: unknown, res: unknown, next: () => void) => Promise<void>)(
      req,
      res,
      () => {
        res.statusCode = 404
        res.end()
        resolve()
      },
    ).then(resolve)
  })
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as AddressInfo).port
const base = `http://127.0.0.1:${port}`

after(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  await fsp.rm(HOME, { recursive: true, force: true })
})

async function jpost<T>(url: string, body: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(base + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (await res.json().catch(() => ({}))) as T
  return { status: res.status, json }
}

async function jget<T>(url: string): Promise<{ status: number; json: T }> {
  const res = await fetch(base + url)
  const json = (await res.json().catch(() => ({}))) as T
  return { status: res.status, json }
}

test('E2E: 全链路 handoff 创建 -> stale -> open-native', async () => {
  // 1. 创建 handoff
  const created = await jpost<{
    handoffId: string
    files: { canonical: { summary: string }; entries: { codex: string; claude: string } }
    sourceSnapshot: { fileMtimeMs?: number }
  }>('/api/handoffs', {
    source: { kind: 'native-session', source: 'claude-code', sessionId: SESSION_ID },
    target: 'both',
    currentRequest: 'continue where we left off',
  })
  assert.equal(created.status, 201)
  assert.ok(created.json.handoffId)

  // 落盘验证
  for (const p of [
    created.json.files.canonical.summary,
    created.json.files.entries.codex,
    created.json.files.entries.claude,
  ]) {
    const stat = await fsp.stat(p)
    assert.ok(stat.size > 0)
  }
  const summary = await fsp.readFile(created.json.files.canonical.summary, 'utf8')
  assert.match(summary, /Please refactor login flow/)
  assert.match(summary, /continue where we left off/)

  // 2. GET handoff -> freshness=fresh
  const got1 = await jget<{ freshness: { status: string } }>(
    `/api/handoffs/${created.json.handoffId}`,
  )
  assert.equal(got1.status, 200)
  assert.equal(got1.json.freshness.status, 'fresh')

  // 3. 推进 source(追加一行 + touch mtime),再 GET -> stale
  await new Promise((r) => setTimeout(r, 20))
  const extra = JSON.stringify({
    type: 'user',
    uuid: 'u2',
    cwd: '/tmp/e2e',
    timestamp: '2025-01-02T00:00:00Z',
    message: { role: 'user', content: [{ type: 'text', text: 'one more thing' }] },
  })
  await fsp.appendFile(sessionFile, extra + '\n', 'utf8')
  const futureTime = new Date(Date.now() + 60_000)
  await fsp.utimes(sessionFile, futureTime, futureTime)

  const got2 = await jget<{ freshness: { status: string; reason?: string } }>(
    `/api/handoffs/${created.json.handoffId}`,
  )
  assert.equal(got2.status, 200)
  assert.equal(got2.json.freshness.status, 'stale')
  assert.match(got2.json.freshness.reason ?? '', /advanced/)

  // 4. open-native codex -> deeplink
  const codex = await jpost<{ nativeLink: { method: string; url?: string; status: string } }>(
    `/api/handoffs/${created.json.handoffId}/open-native`,
    { provider: 'codex' },
  )
  assert.equal(codex.status, 200)
  assert.equal(codex.json.nativeLink.method, 'deeplink')
  assert.equal(codex.json.nativeLink.status, 'created')
  assert.ok(codex.json.nativeLink.url?.startsWith('codex://threads/new?'))

  // 5. open-native claude -> manual + fallbackPrompt
  const claude = await jpost<{ nativeLink: { method: string }; fallbackPrompt?: string }>(
    `/api/handoffs/${created.json.handoffId}/open-native`,
    { provider: 'claude' },
  )
  assert.equal(claude.status, 200)
  assert.equal(claude.json.nativeLink.method, 'manual')
  assert.ok(claude.json.fallbackPrompt?.startsWith('# Continue In Claude'))

  // 6. native-link 已持久化到 manifest
  const got3 = await jget<{ nativeLinks: Array<{ provider: string }> }>(
    `/api/handoffs/${created.json.handoffId}`,
  )
  assert.equal(got3.status, 200)
  const providers = got3.json.nativeLinks.map((l) => l.provider).sort()
  assert.deepEqual(providers, ['claude', 'codex'])

  // 7. 未知 handoff -> 404
  const missing = await jget(`/api/handoffs/does-not-exist`)
  assert.equal(missing.status, 404)
})

test('E2E: group-from-session 建群 + 导入事件', async () => {
  const created = await jpost<{ groupThreadId: string }>('/api/group-threads/from-session', {
    source: 'claude-code',
    sessionId: SESSION_ID,
    agents: ['claude', 'codex'],
    includeRecentEvents: 10,
  })
  assert.equal(created.status, 201)
  assert.ok(created.json.groupThreadId)

  // transcript.jsonl 应含导入的 user/assistant + imported_from meta
  const transcriptPath = path.join(
    HOME,
    '.cockpit',
    'group-threads',
    created.json.groupThreadId,
    'transcript.jsonl',
  )
  const raw = await fsp.readFile(transcriptPath, 'utf8')
  const lines = raw.trim().split('\n').map((l) => JSON.parse(l))
  const hasImported = lines.some(
    (l) => l.type === 'meta' && l.key === 'imported_from' && l.value?.source === 'claude-code',
  )
  assert.ok(hasImported, 'imported_from meta missing')
  const hasUser = lines.some((l) => l.type === 'user_text' && /refactor login/.test(l.text ?? ''))
  assert.ok(hasUser, 'user_text not imported')
})

test('E2E: 400 on invalid source', async () => {
  const bad = await jpost('/api/handoffs', { source: { kind: 'weird' }, target: 'both' })
  assert.equal(bad.status, 400)
})
