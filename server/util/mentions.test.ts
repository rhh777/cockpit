import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMentions, resolveMentionTargets, scanMentions } from './mentions'

test('parseMentions: mention 唤醒并去重', () => {
  assert.deepEqual(parseMentions('@claude @claude @codex 看一下'), ['claude', 'codex'])
  assert.deepEqual(parseMentions('我刚才让 @codex 看了这个'), ['codex'])
  assert.deepEqual(parseMentions('@opencode @cursor 也看一下'), ['opencode', 'cursor'])
})

test('parseMentions: inline code、blockquote 不唤醒', () => {
  assert.deepEqual(parseMentions('`@codex` 看起来只是代码'), [])
  assert.deepEqual(parseMentions('> @claude quoted'), [])
})

test('parseMentions: fenced code block 不唤醒', () => {
  assert.deepEqual(parseMentions('```text\n@codex\n```\n@claude ok'), ['claude'])
})

test('scanMentions: @all 及别名标记全员', () => {
  for (const text of ['@all 看一下', '@everyone 看一下', '@所有人 看一下', '@大家 看一下', '@全体 看一下']) {
    assert.equal(scanMentions(text).all, true, text)
  }
  assert.equal(scanMentions('@ALL 看一下').all, true)
  assert.equal(scanMentions('@claude 看一下').all, false)
})

test('scanMentions: @all 不误伤相似词,也不在代码块里生效', () => {
  assert.equal(scanMentions('@allen 是谁').all, false)
  assert.equal(scanMentions('`@all` 只是字面量').all, false)
  assert.equal(scanMentions('> @all quoted').all, false)
  assert.equal(scanMentions('```\n@all\n```').all, false)
})

test('resolveMentionTargets: @all 展开成花名册,普通 mention 只保留花名册内成员', () => {
  assert.deepEqual(resolveMentionTargets('@all 看一下', ['claude', 'codex']), ['claude', 'codex'])
  assert.deepEqual(resolveMentionTargets('@所有人 看一下', ['codex']), ['codex'])
  assert.deepEqual(resolveMentionTargets('@claude @cursor 看一下', ['claude', 'codex']), ['claude'])
  assert.deepEqual(resolveMentionTargets('没有 mention', ['claude']), [])
})

test('scanMentions: @all 与具体 agent 混用时都被记录', () => {
  const scan = scanMentions('@all 先看,然后 @codex 复核')
  assert.equal(scan.all, true)
  assert.deepEqual(scan.agents, ['codex'])
})
