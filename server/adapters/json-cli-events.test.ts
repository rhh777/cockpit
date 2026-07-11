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

test('normalizeJsonCliEvent: OpenCode text part -> assistant_text', () => {
  const events = normalizeJsonCliEvent(
    {
      type: 'text',
      timestamp: 1783693306101,
      part: {
        id: 'prt_1',
        messageID: 'msg_1',
        type: 'text',
        text: 'cockpit-opencode-smoke',
      },
    },
    'opencode',
  )
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'assistant_text')
  assert.equal(events[0].agent, 'opencode')
  assert.equal((events[0] as any).text, 'cockpit-opencode-smoke')
  assert.equal((events[0] as any).streamId, 'prt_1')
  assert.match(events[0].ts, /^2026-/)
})

test('normalizeJsonCliEvent: OpenCode completed tool part emits paired tool events', () => {
  const events = normalizeJsonCliEvent(
    {
      type: 'tool_use',
      timestamp: 1783693345847,
      part: {
        id: 'prt_tool',
        type: 'tool',
        tool: 'read',
        callID: 'call_1',
        state: {
          status: 'completed',
          input: { filePath: '/tmp/package.json' },
          output: 'contents',
        },
      },
    },
    'opencode',
  )
  assert.equal(events.length, 2)
  assert.equal(events[0].type, 'tool_use')
  assert.equal((events[0] as any).id, 'call_1')
  assert.equal((events[0] as any).name, 'read')
  assert.deepEqual((events[0] as any).input, { filePath: '/tmp/package.json' })
  assert.equal(events[1].type, 'tool_result')
  assert.equal((events[1] as any).toolUseId, 'call_1')
  assert.equal((events[1] as any).output, 'contents')
})

test('normalizeJsonCliEvent: OpenCode step finish tokens -> usage', () => {
  const events = normalizeJsonCliEvent(
    {
      type: 'step_finish',
      part: {
        type: 'step-finish',
        tokens: { input: 12, output: 3, reasoning: 2 },
      },
    },
    'opencode',
  )
  assert.equal(events[0].type, 'usage')
  assert.equal((events[0] as any).inputTokens, 12)
  assert.equal((events[0] as any).outputTokens, 3)
  assert.equal(events[1].type, 'meta')
})
