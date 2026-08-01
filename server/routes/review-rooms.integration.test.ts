import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer, type Server } from 'node:http'
import type { NormalizedEvent } from '../loaders/types'
import type { AgentRunInput, ReviewAgent } from '../adapters/types'

const testHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'cockpit-review-routes-'))
process.env.HOME = testHome

const { cockpitApi } = await import('../index')
const { reviewStateFile } = await import('../store/review-room-store')
const { COCKPIT_HANDOFFS_ROOT } = await import('../config')
const { runRegistry } = await import('../runs/run-registry')
const { registerAgent, resolveAgent } = await import('../adapters/registry')
const realClaude = resolveAgent('claude')

const fastClaude: ReviewAgent = {
  name: 'claude',
  displayName: 'Claude',
  async isAvailable() { return true },
  async *run(): AsyncGenerator<NormalizedEvent> {
    yield { type: 'assistant_text', text: 'No new findings.', ts: new Date().toISOString(), agent: 'claude' }
  },
}
registerAgent(fastClaude)

let server: Server
let baseUrl = ''

before(async () => {
  const api = cockpitApi()
  server = createServer((req, res) => api(req, res, () => {
    res.statusCode = 404
    res.end()
  }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind')
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  const deadline = Date.now() + 30_000
  while (runRegistry.listRunning().length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  registerAgent(realClaude)
  await fsp.rm(testHome, { recursive: true, force: true })
})

async function request(pathname: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: {
      Origin: baseUrl,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

async function post(pathname: string, body: unknown): Promise<Response> {
  return request(pathname, { method: 'POST', body: JSON.stringify(body) })
}

test('Review Room route validates allowed roots and leaves native files untouched', async () => {
  const repo = path.join(testHome, 'repo')
  const native = path.join(testHome, '.codex', 'sessions', 'sentinel.jsonl')
  await fsp.mkdir(repo, { recursive: true })
  await fsp.mkdir(path.dirname(native), { recursive: true })
  await fsp.writeFile(path.join(repo, 'README.md'), '# test\n')
  await fsp.writeFile(native, 'native-history-must-not-change\n')

  const created = await post('/api/review-rooms', {
    source: { kind: 'repository', path: repo },
    goal: 'Review safely',
    participants: ['claude', 'codex'],
    startReview: false,
    promptLocale: 'zh-CN',
  })
  assert.equal(created.status, 201)
  const createdBody = await created.json() as { state: { title: string } }
  assert.equal(createdBody.state.title, '仓库评审：repo')
  assert.equal(await fsp.readFile(native, 'utf8'), 'native-history-must-not-change\n')

  const rejected = await post('/api/review-rooms', {
    source: { kind: 'repository', path: '/private/tmp/outside-test-home' },
    goal: 'Must fail',
  })
  assert.equal(rejected.status, 400)
})

test('corrupt review-state degrades to ordinary group state with a warning', async () => {
  const created = await post('/api/review-rooms', {
    source: { kind: 'freeform', freeformText: 'A plan' },
    goal: 'Review it',
    startReview: false,
  })
  const body = await created.json() as { reviewRoomId: string }
  await fsp.writeFile(reviewStateFile(body.reviewRoomId), '{broken', 'utf8')

  const response = await request(`/api/review-rooms/${body.reviewRoomId}`)
  assert.equal(response.status, 200)
  const detail = await response.json() as { state?: { id: string }; review?: unknown; warning?: { code: string } }
  assert.equal(detail.state?.id, body.reviewRoomId)
  assert.equal(detail.review, null)
  assert.equal(detail.warning?.code, 'corrupt_review_state')
})

test('fresh review creates a child room and a handoff for group-backed source', async () => {
  const groupResponse = await post('/api/group-threads', { title: 'Source group', agents: ['claude', 'codex'] })
  assert.equal(groupResponse.status, 201)
  const group = await groupResponse.json() as { id: string }

  const parentResponse = await post('/api/review-rooms', {
    source: { kind: 'group-thread', groupThreadId: group.id },
    goal: 'Review the source group',
    startReview: false,
    promptLocale: 'zh-CN',
  })
  const parent = await parentResponse.json() as { reviewRoomId: string }
  const freshResponse = await post(`/api/review-rooms/${parent.reviewRoomId}/fresh-review`, {
    reviewerAgents: ['claude'],
  })
  assert.equal(freshResponse.status, 201)
  const fresh = await freshResponse.json() as { childReviewRoomId: string }
  assert.ok(fresh.childReviewRoomId)
  const childDetail = await (await request(`/api/review-rooms/${fresh.childReviewRoomId}`)).json() as {
    state: { title: string }
  }
  assert.match(childDetail.state.title, /^独立复核 · /)

  const entries = await fsp.readdir(COCKPIT_HANDOFFS_ROOT)
  assert.ok(entries.length >= 1)
  const parentDetail = await (await request(`/api/review-rooms/${parent.reviewRoomId}`)).json() as {
    review: { freshReviews: { childReviewRoomId: string; handoffId?: string }[] }
  }
  assert.equal(parentDetail.review.freshReviews[0]?.childReviewRoomId, fresh.childReviewRoomId)
  assert.ok(parentDetail.review.freshReviews[0]?.handoffId)
})

test('cancel Review Room aborts the whole running round and persists terminal state', async () => {
  const slowClaude: ReviewAgent = {
    name: 'claude',
    displayName: 'Claude',
    async isAvailable() { return true },
    async *run(input: AgentRunInput): AsyncGenerator<NormalizedEvent> {
      await new Promise<void>((resolve) => {
        if (input.signal.aborted) return resolve()
        input.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      throw new Error('aborted')
    },
  }
  registerAgent(slowClaude)
  try {
    const created = await post('/api/review-rooms', {
      source: { kind: 'freeform', freeformText: 'cancel test' },
      goal: 'Review until canceled',
      participants: ['claude'],
      startReview: false,
    })
    const room = await created.json() as { reviewRoomId: string }
    const started = await post(`/api/review-rooms/${room.reviewRoomId}/review`, {
      participants: ['claude'],
    })
    assert.equal(started.status, 202)

    const canceled = await post(`/api/review-rooms/${room.reviewRoomId}/cancel`, {})
    assert.equal(canceled.status, 202)
    const body = await canceled.json() as {
      canceled: boolean
      review: { rounds: { status: string; completedAt?: string }[] }
    }
    assert.equal(body.canceled, true)
    assert.equal(body.review.rounds[0]?.status, 'aborted')
    assert.ok(body.review.rounds[0]?.completedAt)
  } finally {
    registerAgent(fastClaude)
  }
})
