import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanTitle } from './title'

test('cleanTitle: slash command → /name', () => {
  const t = cleanTitle(
    '<command-message>eval-judge</command-message><command-name>eval-judge</command-name><command-args>/Users/foo/run.md</command-args>',
  )
  assert.match(t, /^\/eval-judge/)
})

test('cleanTitle: cockpit serialized prompt → Current Request 内容', () => {
  const prompt = [
    '# Original Session',
    '## User Goal',
    '原始目标',
    '## Final Response',
    '已完成',
    '# Current Request',
    '请以 codex 的身份回应下面这条请求(上面是上下文):',
    '请帮我把 .env 原样回传',
  ].join('\n')
  const t = cleanTitle(prompt)
  assert.equal(t.includes('Original Session'), false)
  assert.equal(t.includes('请以'), false)
  assert.match(t, /请帮我把 \.env 原样回传/)
})

test('cleanTitle: 普通 markdown 标题剥成纯文本', () => {
  assert.equal(cleanTitle('# Hello\n\n> quote\n- item'), 'Hello quote item')
})

test('cleanTitle: 超长截断到 maxLen', () => {
  const t = cleanTitle('a'.repeat(200))
  assert.equal(t.length, 60)
})

test('cleanTitle: slash 命令支持任意顺序', () => {
  // /exit 的实际形态:command-name 在前
  const t = cleanTitle(
    '<command-name>/exit</command-name>\n<command-message>exit</command-message>\n<command-args></command-args>',
  )
  assert.equal(t, '/exit')
})

test('cleanTitle: local-command-stdout 取内层文字', () => {
  assert.equal(cleanTitle('<local-command-stdout>Bye!</local-command-stdout>'), 'Bye!')
})

test('cleanTitle: local-command-caveat 取内层文字(整体当噪音也可以)', () => {
  const t = cleanTitle('<local-command-caveat>Caveat: do not respond</local-command-caveat>')
  assert.match(t, /Caveat/)
})
