import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReviewRoomSource } from '../store/review-room-store'
import { computeSourceFreshness, type FreshnessProbe } from './source-freshness'

const TS = '2026-07-31T00:00:00.000Z'

function probe(over: Partial<FreshnessProbe> = {}): FreshnessProbe {
  return {
    gitHead: async () => undefined,
    fileMtimeMs: async () => null,
    dirExists: async () => true,
    nativeSession: async () => null,
    groupThread: async () => null,
    ...over,
  }
}

function source(kind: ReviewRoomSource['kind'], over: Partial<ReviewRoomSource> = {}): ReviewRoomSource {
  return { kind, title: 't', cwd: null, snapshotCreatedAt: TS, ...over }
}

test('freeform 永远 fresh(没有外部来源)', async () => {
  const r = await computeSourceFreshness(source('freeform', { freeformText: 'x' }), probe())
  assert.equal(r.status, 'fresh')
  assert.equal(r.reason, 'freeform')
})

test('repository:git HEAD 未变 → fresh', async () => {
  const s = source('repository', {
    cwd: '/repo',
    paths: [{ kind: 'repository', path: '/repo', name: 'repo' }],
    sourceSnapshot: { gitHead: 'abc' },
  })
  const r = await computeSourceFreshness(s, probe({ gitHead: async () => 'abc' }))
  assert.equal(r.status, 'fresh')
})

test('repository:git HEAD 变了 → stale', async () => {
  const s = source('repository', {
    cwd: '/repo',
    paths: [{ kind: 'repository', path: '/repo', name: 'repo' }],
    sourceSnapshot: { gitHead: 'abc' },
  })
  const r = await computeSourceFreshness(s, probe({ gitHead: async () => 'def' }))
  assert.equal(r.status, 'stale')
  assert.equal(r.reason, 'git-head-changed')
})

test('repository:目录没了 → missing', async () => {
  const s = source('repository', {
    cwd: '/gone',
    paths: [{ kind: 'repository', path: '/gone', name: 'gone' }],
    sourceSnapshot: { gitHead: 'abc' },
  })
  const r = await computeSourceFreshness(s, probe({ dirExists: async () => false }))
  assert.equal(r.status, 'missing')
})

// 老房间没有基线字段:必须是 unknown,不能误报 stale。
test('repository:快照没有 gitHead → unknown 而不是 stale', async () => {
  const s = source('repository', {
    cwd: '/repo',
    paths: [{ kind: 'repository', path: '/repo', name: 'repo' }],
  })
  const r = await computeSourceFreshness(s, probe({ gitHead: async () => 'def' }))
  assert.equal(r.status, 'unknown')
  assert.equal(r.reason, 'no-baseline')
})

test('files:某个文件被改过 → stale,并指出是哪个', async () => {
  const s = source('files', {
    paths: [
      { kind: 'file', path: '/a.ts', name: 'a.ts' },
      { kind: 'file', path: '/b.ts', name: 'b.ts' },
    ],
    sourceSnapshot: {
      pathMtimes: [
        { path: '/a.ts', mtimeMs: 100 },
        { path: '/b.ts', mtimeMs: 100 },
      ],
    },
  })
  const r = await computeSourceFreshness(s, probe({ fileMtimeMs: async (p) => (p === '/b.ts' ? 200 : 100) }))
  assert.equal(r.status, 'stale')
  assert.equal(r.reason, 'file-modified')
  assert.equal(r.detail, '/b.ts')
})

test('files:mtime 没变 → fresh', async () => {
  const s = source('document', {
    paths: [{ kind: 'document', path: '/d.md', name: 'd.md' }],
    sourceSnapshot: { pathMtimes: [{ path: '/d.md', mtimeMs: 100 }] },
  })
  const r = await computeSourceFreshness(s, probe({ fileMtimeMs: async () => 100 }))
  assert.equal(r.status, 'fresh')
})

test('files:文件被删 → missing', async () => {
  const s = source('files', {
    paths: [{ kind: 'file', path: '/a.ts', name: 'a.ts' }],
    sourceSnapshot: { pathMtimes: [{ path: '/a.ts', mtimeMs: 100 }] },
  })
  const r = await computeSourceFreshness(s, probe({ fileMtimeMs: async () => null }))
  assert.equal(r.status, 'missing')
  assert.equal(r.reason, 'file-missing')
})

test('native-session:文件又被写过 → stale', async () => {
  const s = source('native-session', {
    nativeSession: { source: 'claude-code', sessionId: 'sess' },
    sourceSnapshot: { fileMtimeMs: 100, eventCount: 10 },
  })
  const r = await computeSourceFreshness(s, probe({ nativeSession: async () => ({ fileMtimeMs: 200 }) }))
  assert.equal(r.status, 'stale')
  assert.equal(r.reason, 'session-modified')
})

test('native-session:事件数增长 → stale', async () => {
  const s = source('native-session', {
    nativeSession: { source: 'claude-code', sessionId: 'sess' },
    sourceSnapshot: { eventCount: 10 },
  })
  const r = await computeSourceFreshness(
    s,
    probe({ nativeSession: async () => ({ eventCount: 12 }) }),
  )
  assert.equal(r.status, 'stale')
  assert.equal(r.reason, 'session-grew')
})

test('native-session:session 不见了 → missing', async () => {
  const s = source('native-session', {
    nativeSession: { source: 'claude-code', sessionId: 'sess' },
    sourceSnapshot: { eventCount: 10 },
  })
  const r = await computeSourceFreshness(s, probe({ nativeSession: async () => null }))
  assert.equal(r.status, 'missing')
})

test('group-thread:transcript 增长 → stale', async () => {
  const s = source('group-thread', {
    groupThreadId: 'g1',
    sourceSnapshot: { eventCount: 5, summaryRevision: 1 },
  })
  const r = await computeSourceFreshness(
    s,
    probe({ groupThread: async () => ({ eventCount: 9, summaryRevision: 1 }) }),
  )
  assert.equal(r.status, 'stale')
  assert.equal(r.reason, 'transcript-grew')
})

test('group-thread:只有 summary 修订推进 → stale', async () => {
  const s = source('group-thread', {
    groupThreadId: 'g1',
    sourceSnapshot: { eventCount: 5, summaryRevision: 1 },
  })
  const r = await computeSourceFreshness(
    s,
    probe({ groupThread: async () => ({ eventCount: 5, summaryRevision: 3 }) }),
  )
  assert.equal(r.status, 'stale')
  assert.equal(r.reason, 'summary-updated')
})

test('group-thread:都没变 → fresh', async () => {
  const s = source('group-thread', {
    groupThreadId: 'g1',
    sourceSnapshot: { eventCount: 5, summaryRevision: 1 },
  })
  const r = await computeSourceFreshness(
    s,
    probe({ groupThread: async () => ({ eventCount: 5, summaryRevision: 1 }) }),
  )
  assert.equal(r.status, 'fresh')
})

// 计数只减不增(比如用户删了历史)不该报 stale —— 我们只关心「有没有新内容」。
test('事件数变少不算 stale', async () => {
  const s = source('group-thread', { groupThreadId: 'g1', sourceSnapshot: { eventCount: 9 } })
  const r = await computeSourceFreshness(s, probe({ groupThread: async () => ({ eventCount: 5 }) }))
  assert.equal(r.status, 'fresh')
})
