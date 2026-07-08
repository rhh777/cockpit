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

after(async () => {
  await fsp.rm(threadDir(SRC, ID), { recursive: true, force: true })
  await fsp.rm(nativeFile, { force: true })
})

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
