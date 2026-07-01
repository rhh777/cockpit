import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

process.env.HOME = await fsp.mkdtemp(path.join(os.tmpdir(), 'cockpit-handoff-'))

const { handoffStore, computeFreshness } = await import('../store/handoff-store')
const { buildCodexDeeplink, CODEX_PROMPT_BUDGET } = await import('./codex-deeplink')
const { _internal } = await import('./context-builder')
const { COCKPIT_HANDOFFS_ROOT } = await import('../config')

after(async () => {
  await fsp.rm(process.env.HOME!, { recursive: true, force: true })
})

test('HandoffStore: 创建后落盘 manifest + 所有 markdown 文件', async () => {
  const manifest = await handoffStore.create({
    sourceRef: { kind: 'group-thread', groupThreadId: 'g1' },
    context: {
      title: 'T',
      cwd: '/x',
      snapshot: { sourceUpdatedAt: '2025-01-01T00:00:00Z', sourceEventCount: 1 },
      canonical: {
        summary: '# S',
        transcript: '# T',
        decisions: '# D',
        taskState: '# K',
        fileRefs: '# F',
      },
      entries: { codex: '# CX', claude: '# CL' },
    },
  })
  assert.ok(manifest.handoffId)
  assert.equal(manifest.snapshotMode, 'snapshot')
  for (const p of [
    manifest.files.canonical.summary,
    manifest.files.canonical.transcript,
    manifest.files.canonical.decisions,
    manifest.files.canonical.taskState,
    manifest.files.canonical.fileRefs,
    manifest.files.entries.codex,
    manifest.files.entries.claude,
  ]) {
    const stat = await fsp.stat(p)
    assert.ok(stat.size > 0, `${p} empty`)
  }
  assert.ok(manifest.files.canonical.summary.startsWith(COCKPIT_HANDOFFS_ROOT))
})

test('computeFreshness: updatedAt 推进 -> stale', () => {
  const f = computeFreshness(
    { sourceUpdatedAt: '2025-01-01T00:00:00Z', sourceEventCount: 5 },
    { sourceUpdatedAt: '2025-02-01T00:00:00Z', sourceEventCount: 5 },
  )
  assert.equal(f.status, 'stale')
})

test('computeFreshness: 无变化 -> fresh', () => {
  const f = computeFreshness(
    { sourceUpdatedAt: '2025-01-01T00:00:00Z', sourceEventCount: 5 },
    { sourceUpdatedAt: '2025-01-01T00:00:00Z', sourceEventCount: 5 },
  )
  assert.equal(f.status, 'fresh')
})

test('computeFreshness: current 为 null -> unknown', () => {
  const f = computeFreshness({ sourceUpdatedAt: null, sourceEventCount: null }, null)
  assert.equal(f.status, 'unknown')
})

test('buildCodexDeeplink: 短 prompt 在预算内', () => {
  const result = buildCodexDeeplink({
    handoffId: 'h1',
    source: { kind: 'group-thread' },
    createdAt: '',
    cwd: '/x/y',
    title: '',
    snapshotMode: 'snapshot',
    sourceSnapshot: { sourceUpdatedAt: null, sourceEventCount: null },
    files: {
      canonical: { summary: '', transcript: '', decisions: '', taskState: '', fileRefs: '' },
      entries: { codex: '/x/y/handoff.codex.md', claude: '' },
    },
    nativeLinks: [],
  })
  assert.equal(result.overBudget, false)
  assert.ok(result.url.startsWith('codex://threads/new?path='))
  assert.ok(result.promptEncodedLength < CODEX_PROMPT_BUDGET)
  assert.ok(result.url.includes(encodeURIComponent('/x/y/handoff.codex.md')))
})

test('buildSummary: 含首尾 user_text 字段', () => {
  const summary = _internal.buildSummary(
    {
      title: 't',
      cwd: '/x',
      events: [
        { origin: 'cockpit', source: 'cockpit', event: { type: 'user_text', text: 'first', ts: '' } },
        { origin: 'cockpit', source: 'cockpit', event: { type: 'assistant_text', text: 'answer', ts: '' } },
        { origin: 'cockpit', source: 'cockpit', event: { type: 'user_text', text: 'last', ts: '' } },
      ],
      snapshot: { sourceUpdatedAt: null, sourceEventCount: 3 },
    },
    'do this',
  )
  assert.match(summary, /first/)
  assert.match(summary, /last/)
  assert.match(summary, /answer/)
  assert.match(summary, /do this/)
})

test('buildFileRefs: 抽取 tool_use 路径与命令', () => {
  const text = _internal.buildFileRefs({
    title: 't',
    cwd: '/repo',
    events: [
      {
        origin: 'cockpit',
        source: 'cockpit',
        event: {
          type: 'tool_use',
          id: 't1',
          name: 'Read',
          input: { file_path: '/repo/a.ts' },
          ts: '',
        },
      },
      {
        origin: 'cockpit',
        source: 'cockpit',
        event: {
          type: 'tool_use',
          id: 't2',
          name: 'Bash',
          input: { command: 'pnpm test' },
          ts: '',
        },
      },
    ],
    snapshot: { sourceUpdatedAt: null, sourceEventCount: 2 },
  })
  assert.match(text, /\/repo\/a\.ts/)
  assert.match(text, /pnpm test/)
  assert.match(text, /cwd: `\/repo`/)
})

test('buildTranscript: tool_result 经 sensitive filter (敏感路径整体屏蔽)', () => {
  const transcript = _internal.buildTranscript(
    [
      {
        origin: 'cockpit',
        source: 'cockpit',
        event: { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x/.env' }, ts: '' },
      },
      {
        origin: 'cockpit',
        source: 'cockpit',
        event: { type: 'tool_result', toolUseId: 't1', output: 'API_KEY=secret123', isError: false, ts: '' },
      },
    ],
    'full',
  )
  assert.match(transcript, /已屏蔽敏感内容/)
  assert.doesNotMatch(transcript, /secret123/)
})
