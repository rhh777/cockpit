import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { threadStore } from './thread-store'
import { followupsFile, threadDir } from './paths'
import type { EventEnvelope, Source } from '../loaders/types'

const SRC: Source = 'claude-code'
const ID = randomUUID() // 测试用临时 thread,跑完清理

function userEvent(i: number): EventEnvelope {
  return {
    origin: 'cockpit',
    source: SRC,
    sourceEventId: `evt_${i}`,
    turnId: 'turn_x',
    runId: 'run_x',
    event: { type: 'user_text', text: `msg ${i}`, ts: new Date().toISOString() },
  }
}

after(async () => {
  await fsp.rm(threadDir(SRC, ID), { recursive: true, force: true })
})

test('concurrent append: serial queue 不丢行、保持调用顺序', async () => {
  await Promise.all(Array.from({ length: 20 }, (_, i) => threadStore.appendEvent(SRC, ID, userEvent(i))))
  const events = await threadStore.readFollowups(SRC, ID)
  assert.equal(events.length, 20)
  const texts = events.map((e) => (e.event.type === 'user_text' ? e.event.text : ''))
  assert.deepEqual(texts, Array.from({ length: 20 }, (_, i) => `msg ${i}`))
  // 扁平存储 round-trip:origin/turnId/runId 还原
  assert.equal(events[0].origin, 'cockpit')
  assert.equal(events[0].turnId, 'turn_x')
})

test('terminal status 可恢复', async () => {
  await threadStore.appendTurnStatus(SRC, ID, 'turn_x', 'run_x', 'completed')
  const events = await threadStore.readFollowups(SRC, ID)
  const status = events.find(
    (e) => e.event.type === 'meta' && e.event.key === 'turn_status',
  )
  assert.ok(status && status.event.type === 'meta')
  assert.deepEqual((status!.event as any).value, { status: 'completed' })
})

test('crash 半截行:best-effort 读出完整部分,坏行跳过', async () => {
  // 手动写一个合法行 + 一个半截损坏行(模拟崩溃)
  fs.appendFileSync(followupsFile(SRC, ID), '{"origin":"cockpit","type":"user_text","text":"ok","ts":"t"}\n')
  fs.appendFileSync(followupsFile(SRC, ID), '{"origin":"cockpit","type":"assist')
  const events = await threadStore.readFollowups(SRC, ID)
  // 不抛异常,且能读出之前 20 条 + status + 这条 ok = 22(坏行被跳过)
  assert.ok(events.some((e) => e.event.type === 'user_text' && e.event.text === 'ok'))
})

test('clearFollowups 清空', async () => {
  await threadStore.clearFollowups(SRC, ID)
  assert.equal(threadStore.hasFollowups(SRC, ID), false)
  assert.deepEqual(await threadStore.readFollowups(SRC, ID), [])
})
