import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stringifyToolResult } from './jsonl'

test('stringifyToolResult: string passthrough', () => {
  assert.equal(stringifyToolResult('hello'), 'hello')
  assert.equal(stringifyToolResult(null), '')
  assert.equal(stringifyToolResult(undefined), '')
})

test('stringifyToolResult: Claude text/image parts', () => {
  const parts = [
    { type: 'text', text: 'first' },
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    },
    { type: 'text', text: 'last' },
  ]
  const out = stringifyToolResult(parts)
  assert.match(out, /first/)
  assert.match(out, /last/)
  // image 保留 data URL,前端 markdown 可以渲染缩略图
  assert.match(out, /!\[image\]\(data:image\/png;base64,AAAA\)/)
})

test('stringifyToolResult: MCP { content: [...] } 拆包', () => {
  const mcp = { content: [{ type: 'text', text: 'mcp out' }] }
  assert.equal(stringifyToolResult(mcp), 'mcp out')
})

test('stringifyToolResult: 嵌套 MCP', () => {
  const nested = {
    content: [
      { type: 'text', text: 'a' },
      { content: [{ type: 'text', text: 'b' }] },
    ],
  }
  assert.equal(stringifyToolResult(nested), 'a\nb')
})

test('stringifyToolResult: 未知对象兜底 JSON', () => {
  assert.equal(stringifyToolResult({ foo: 1 }), '{"foo":1}')
})
