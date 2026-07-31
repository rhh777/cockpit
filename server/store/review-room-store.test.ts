// docs/14 §Fix「I'll fix manually」/「I fixed it, verify now」的状态机。
// 直接打真实的 ~/.cockpit(和 group-thread-store.test.ts 同样的做法),after 里清理。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import type { AgentName } from '../loaders/types'
import { groupThreadDir } from './group-thread-store'
import { reviewRoomStore } from './review-room-store'

const created = new Set<string>()

after(async () => {
  await Promise.all([...created].map((id) => fsp.rm(groupThreadDir(id), { recursive: true, force: true })))
})

let seq = 0
async function room() {
  const id = `zz-manual-fix-test-${process.pid}-${seq++}`
  await fsp.mkdir(groupThreadDir(id), { recursive: true })
  created.add(id)
  await reviewRoomStore.create({
    groupThreadId: id,
    source: { kind: 'freeform', title: 't', cwd: null, snapshotCreatedAt: new Date().toISOString() },
    goal: 'g',
    participants: ['claude', 'codex'] as AgentName[],
  })
  return id
}

test('startManualFix:phase 进 fix,插入 awaiting-user 的手动轮', async () => {
  const id = await room()
  const next = await reviewRoomStore.startManualFix(id)
  assert.ok(next)
  assert.equal(next.phase, 'fix')
  assert.equal(next.rounds.length, 1)
  assert.equal(next.rounds[0].kind, 'fix')
  assert.equal(next.rounds[0].mode, 'manual')
  assert.equal(next.rounds[0].status, 'awaiting-user')
  // 手动轮没有 agent,也没有 groupTurnId —— 它不对应任何 run。
  assert.deepEqual(next.rounds[0].agents, [])
  assert.equal(next.rounds[0].groupTurnId, undefined)
})

test('startManualFix 幂等:重复点不会插入第二个挂起轮', async () => {
  const id = await room()
  await reviewRoomStore.startManualFix(id)
  const next = await reviewRoomStore.startManualFix(id)
  assert.equal(next?.rounds.filter((r) => r.status === 'awaiting-user').length, 1)
  assert.equal(next?.rounds.length, 1)
})

test('closeManualFix:挂起轮收成 completed 并记 completedAt', async () => {
  const id = await room()
  await reviewRoomStore.startManualFix(id)
  const next = await reviewRoomStore.closeManualFix(id)
  assert.ok(next)
  assert.equal(next.rounds[0].status, 'completed')
  assert.ok(next.rounds[0].completedAt)
  assert.equal(next.rounds.some((r) => r.status === 'awaiting-user'), false)
})

test('没有挂起轮时 closeManualFix 是 no-op', async () => {
  const id = await room()
  const before = await reviewRoomStore.read(id)
  const next = await reviewRoomStore.closeManualFix(id)
  assert.deepEqual(next?.rounds, before?.rounds)
})

test('手动修复不影响已有轮次', async () => {
  const id = await room()
  await reviewRoomStore.startRound(id, {
    kind: 'review',
    mode: 'parallel',
    agents: ['claude'] as AgentName[],
    groupTurnId: 'turn_1',
    status: 'completed',
  })
  const next = await reviewRoomStore.startManualFix(id)
  assert.equal(next?.rounds.length, 2)
  assert.equal(next?.rounds[0].status, 'completed')
  assert.equal(next?.rounds[1].status, 'awaiting-user')
})

test('setDone 不会被手动修复轮挡住(awaiting-user 不是 running)', async () => {
  const id = await room()
  await reviewRoomStore.startManualFix(id)
  const state = await reviewRoomStore.read(id)
  // route 的 409 只看 status === 'running';这里断言手动轮不会被算进去。
  assert.equal(state?.rounds.some((r) => r.status === 'running'), false)
  const done = await reviewRoomStore.setDone(id, true, 'ok')
  assert.equal(done?.phase, 'done')
})
