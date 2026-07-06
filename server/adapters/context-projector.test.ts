import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectContextEvents } from './context-projector'
import type { EventEnvelope } from '../loaders/types'

test('projectContextEvents summarizes large tool_result without mutating source event', () => {
  const output = 'a'.repeat(20) + 'b'.repeat(20) + 'c'.repeat(20)
  const events: EventEnvelope[] = [
    {
      origin: 'cockpit',
      source: 'cockpit',
      event: {
        type: 'tool_result',
        toolUseId: 'tool_1',
        output,
        isError: false,
        ts: '2026-01-01T00:00:00.000Z',
      },
    },
  ]

  const projected = projectContextEvents(events, {
    largeToolResultChars: 30,
    toolResultHeadChars: 10,
    toolResultTailChars: 8,
  })

  assert.equal(events[0].event.type, 'tool_result')
  if (events[0].event.type === 'tool_result') assert.equal(events[0].event.output, output)
  assert.notEqual(projected[0], events[0])
  assert.equal(projected[0].event.type, 'tool_result')
  if (projected[0].event.type === 'tool_result') {
    assert.match(projected[0].event.output, /Large tool output summarized/)
    assert.match(projected[0].event.output, /omitted 42 chars/)
    assert.ok(projected[0].event.output.includes('aaaaaaaaaa'))
    assert.ok(projected[0].event.output.endsWith('cccccccc'))
  }
})

test('projectContextEvents leaves small tool_result object identity unchanged', () => {
  const events: EventEnvelope[] = [
    {
      origin: 'cockpit',
      source: 'cockpit',
      event: {
        type: 'tool_result',
        toolUseId: 'tool_1',
        output: 'short',
        isError: false,
        ts: '2026-01-01T00:00:00.000Z',
      },
    },
  ]
  assert.equal(projectContextEvents(events, { largeToolResultChars: 30 })[0], events[0])
})
