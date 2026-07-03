import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeJsonCliEvent } from './json-cli-events'

test('normalizeJsonCliEvent: Cursor content delta -> assistant_text delta', () => {
  const events = normalizeJsonCliEvent({ type: 'content', delta: 'Analyzing...' }, 'cursor')
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'assistant_text')
  assert.equal(events[0].agent, 'cursor')
  assert.equal((events[0] as any).delta, true)
  assert.equal((events[0] as any).text, 'Analyzing...')
})

test('normalizeJsonCliEvent: tool_use and tool_result are preserved', () => {
  const use = normalizeJsonCliEvent({ type: 'tool_use', id: 't1', tool: 'read_file', args: { path: 'a.ts' } }, 'cursor')
  assert.equal(use[0].type, 'tool_use')
  assert.equal((use[0] as any).name, 'read_file')
  assert.deepEqual((use[0] as any).input, { path: 'a.ts' })

  const result = normalizeJsonCliEvent({ type: 'tool_result', id: 't1', output: 'ok' }, 'opencode')
  assert.equal(result[0].type, 'tool_result')
  assert.equal((result[0] as any).toolUseId, 't1')
  assert.equal((result[0] as any).output, 'ok')
})

test('normalizeJsonCliEvent: usage and unknown events survive as meta', () => {
  const usage = normalizeJsonCliEvent({ type: 'end', usage: { input_tokens: 10, output_tokens: 5 } }, 'opencode')
  assert.equal(usage[0].type, 'usage')
  assert.equal((usage[0] as any).inputTokens, 10)
  assert.equal((usage[0] as any).outputTokens, 5)
  assert.equal(usage[1].type, 'meta')
})

