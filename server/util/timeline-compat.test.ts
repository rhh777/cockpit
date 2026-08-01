import assert from 'node:assert/strict'
import test from 'node:test'
import { buildTimeline, isNoiseEvent } from '../../src/lib/timeline'
import type { EventEnvelope } from '../../src/lib/types'

test('buildTimeline collapses persisted Cursor chunks when a matching final message exists', () => {
  const texts = ['大家', '好', '大家好']
  const events: EventEnvelope[] = texts.map((text, index) => ({
    origin: 'cockpit',
    source: 'cockpit',
    turnId: 'turn-1',
    runId: 'run-1',
    sourceEventId: `event-${index}`,
    event: {
      type: 'assistant_text',
      text,
      ts: '2026-08-01T00:00:00.000Z',
      agent: 'cursor',
    },
  }))

  const rows = buildTimeline(events).rows
  assert.equal(rows.length, 1)
  assert.equal(rows[0].envelope.event.type, 'assistant_text')
  if (rows[0].envelope.event.type === 'assistant_text') {
    assert.equal(rows[0].envelope.event.text, '大家好')
  }
})

test('buildTimeline keeps distinct Cursor messages that are not a streamed duplicate', () => {
  const events: EventEnvelope[] = ['第一段', '第二段'].map((text, index) => ({
    origin: 'cockpit',
    source: 'cockpit',
    turnId: 'turn-2',
    runId: 'run-2',
    event: { type: 'assistant_text', text, ts: '2026-08-01T00:00:00.000Z', agent: 'cursor' },
    sourceEventId: `distinct-${index}`,
  }))
  assert.equal(buildTimeline(events).rows.length, 2)
})

test('Cursor protocol frames stay out of the readable timeline', () => {
  const envelope: EventEnvelope = {
    origin: 'cockpit',
    source: 'cockpit',
    event: {
      type: 'meta',
      key: 'cursor_result',
      value: { subtype: 'success' },
      ts: '2026-08-01T00:00:00.000Z',
    },
  }
  assert.equal(isNoiseEvent(envelope), true)
})
