import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { threadStore } from '../store/thread-store'
import { threadDir } from '../store/paths'
import type { Source } from '../loaders/types'
import { subscribe, type WatcherUpdate } from './session-watcher'

const SRC: Source = 'claude-code'
const ID = randomUUID() // 测试用临时 thread,跑完清理
const nativeFile = path.join(os.tmpdir(), `cockpit-watcher-test-${ID}.jsonl`)
const cleanupFiles = new Set<string>([nativeFile])
const cleanupIds = new Set<string>([ID])

after(async () => {
  for (const id of cleanupIds) await fsp.rm(threadDir(SRC, id), { recursive: true, force: true })
  for (const file of cleanupFiles) await fsp.rm(file, { force: true })
})

function claudeLine(uuid: string, text: string): string {
  return JSON.stringify({
    type: 'user',
    uuid,
    timestamp: new Date().toISOString(),
    message: { content: text },
  })
}

async function waitForUpdate(
  updates: WatcherUpdate[],
  predicate: (u: WatcherUpdate) => boolean,
  label: string,
): Promise<WatcherUpdate> {
  const existing = updates.find(predicate)
  if (existing) return existing
  return await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`${label} 未在 6s 内推送`)), 6000)
    const poll = setInterval(() => {
      const found = updates.find(predicate)
      if (!found) return
      clearInterval(poll)
      clearTimeout(deadline)
      resolve(found)
    }, 25)
  })
}

// docs/12 F2:订阅时 followups.jsonl 还不存在 → watcher 建不上;
// 第一条 follow-up 落盘后必须通过周期性补建(REBUILD_INTERVAL_MS)推送出来,
// 而不是永远静默。
test('watcher: 订阅后才出现的 followups 文件能被补建 watch 并推送 append', async () => {
  await fsp.writeFile(nativeFile, '', 'utf8') // 原生文件存在但为空

  const updates: WatcherUpdate[] = []
  let resolveAppend: (() => void) | null = null
  const gotAppend = new Promise<void>((resolve) => {
    resolveAppend = resolve
  })
  const unsubscribe = subscribe(SRC, ID, nativeFile, (msg) => {
    updates.push(msg)
    if (msg.kind === 'append') resolveAppend?.()
  })

  try {
    // 等初始 reload 完成(lastTotal 初始化,不广播)。
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(updates.length, 0)

    // 首条 follow-up 落盘 → 此刻还没有该文件的 watcher,依赖补建。
    await threadStore.appendEvent(SRC, ID, {
      origin: 'cockpit',
      source: SRC,
      sourceEventId: 'evt_first',
      turnId: 'turn_x',
      runId: 'run_x',
      event: { type: 'user_text', text: 'first followup', ts: new Date().toISOString() },
    })

    // 补建间隔 2s + 防抖 50ms,给足余量。
    await Promise.race([
      gotAppend,
      new Promise((_, reject) => setTimeout(() => reject(new Error('append 未在 6s 内推送,补建失效')), 6000)),
    ])

    const append = updates.find((u) => u.kind === 'append')
    assert.ok(append && append.kind === 'append')
    // boundary + follow-up 事件
    assert.ok(append.total >= 2)
    assert.ok(
      append.newEvents.some(
        (e) => e.event.type === 'user_text' && e.event.text === 'first followup',
      ),
    )
  } finally {
    unsubscribe()
  }
})

test('watcher: native 文件截断时增量 state 作废并推送 reset', async () => {
  const id = randomUUID()
  const file = path.join(os.tmpdir(), `cockpit-watcher-test-${id}.jsonl`)
  cleanupIds.add(id)
  cleanupFiles.add(file)
  await fsp.writeFile(file, `${claudeLine('u1', 'before')}\n`, 'utf8')

  const updates: WatcherUpdate[] = []
  const unsubscribe = subscribe(SRC, id, file, (msg) => updates.push(msg))

  try {
    await new Promise((r) => setTimeout(r, 250))
    await fsp.truncate(file, 0)
    const reset = await waitForUpdate(
      updates,
      (u) => u.kind === 'reset' && u.reason === 'truncated',
      'truncate reset',
    )
    assert.equal(reset.kind, 'reset')
  } finally {
    unsubscribe()
  }
})

test('watcher: followup_boundary 后 native 增长仍保持 native-middle-insert reset', async () => {
  const id = randomUUID()
  const file = path.join(os.tmpdir(), `cockpit-watcher-test-${id}.jsonl`)
  cleanupIds.add(id)
  cleanupFiles.add(file)
  await fsp.writeFile(file, `${claudeLine('u1', 'before')}\n`, 'utf8')

  const updates: WatcherUpdate[] = []
  const unsubscribe = subscribe(SRC, id, file, (msg) => updates.push(msg))

  try {
    await new Promise((r) => setTimeout(r, 250))
    await threadStore.appendEvent(SRC, id, {
      origin: 'cockpit',
      source: SRC,
      sourceEventId: 'evt_follow',
      turnId: 'turn_follow',
      runId: 'run_follow',
      event: { type: 'user_text', text: 'followup', ts: new Date().toISOString() },
    })
    await waitForUpdate(
      updates,
      (u) => u.kind === 'append' && u.newEvents.some((e) => e.event.type === 'followup_boundary'),
      'followup append',
    )

    await fsp.appendFile(file, `${claudeLine('u2', 'native after followup')}\n`, 'utf8')
    const reset = await waitForUpdate(
      updates,
      (u) => u.kind === 'reset' && u.reason === 'native-middle-insert',
      'native-middle-insert reset',
    )
    assert.equal(reset.kind, 'reset')
  } finally {
    unsubscribe()
  }
})
