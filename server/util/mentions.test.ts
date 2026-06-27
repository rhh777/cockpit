import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMentions } from './mentions'

test('parseMentions: mention 唤醒并去重', () => {
  assert.deepEqual(parseMentions('@claude @claude @codex 看一下'), ['claude', 'codex'])
  assert.deepEqual(parseMentions('我刚才让 @codex 看了这个'), ['codex'])
})

test('parseMentions: inline code、blockquote 不唤醒', () => {
  assert.deepEqual(parseMentions('`@codex` 看起来只是代码'), [])
  assert.deepEqual(parseMentions('> @claude quoted'), [])
})

test('parseMentions: fenced code block 不唤醒', () => {
  assert.deepEqual(parseMentions('```text\n@codex\n```\n@claude ok'), ['claude'])
})
