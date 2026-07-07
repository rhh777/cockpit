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

function makeUser(id: string, text: string): EventEnvelope {
  return {
    origin: 'native',
    source: 'claude-code',
    sourceEventId: id,
    event: { type: 'user_text', text, ts: '2026-01-01T00:00:00.000Z' },
  }
}
function makeAssistant(id: string, text: string): EventEnvelope {
  return {
    origin: 'native',
    source: 'claude-code',
    sourceEventId: id,
    event: { type: 'assistant_text', text, agent: 'claude', ts: '2026-01-01T00:00:00.000Z' },
  }
}
function makeBoundary(): EventEnvelope {
  return {
    origin: 'cockpit',
    source: 'claude-code',
    sourceEventId: 'boundary',
    event: { type: 'followup_boundary', ts: '2026-01-01T00:00:00.000Z' },
  }
}

test('projectContextEvents incremental replaces pre-checkpoint native block with summary meta', () => {
  const events: EventEnvelope[] = [
    makeUser('u1', '第一轮问题'),
    makeAssistant('a1', '第一轮回答'),
    makeUser('u2', '第二轮问题'),
    makeAssistant('a2', '第二轮回答'),
    makeBoundary(),
    makeUser('f1', 'follow-up 提问'),
  ]

  const projected = projectContextEvents(events, {
    incremental: { summary: 'session 摘要正文', upToSourceEventId: 'a2' },
  })

  // 原生段被替换为一条 meta.context_summary + 边界 + follow-up。
  assert.equal(projected.length, 3)
  assert.equal(projected[0].event.type, 'meta')
  if (projected[0].event.type === 'meta') {
    assert.equal(projected[0].event.key, 'context_summary')
    assert.deepEqual(projected[0].event.value, { summary: 'session 摘要正文' })
  }
  assert.equal(projected[1].event.type, 'followup_boundary')
  assert.equal(projected[2].sourceEventId, 'f1')
})

test('projectContextEvents incremental falls back to full when checkpoint missing', () => {
  const events: EventEnvelope[] = [
    makeUser('u1', 'q'),
    makeAssistant('a1', 'r'),
  ]
  const projected = projectContextEvents(events, {
    incremental: { summary: 's', upToSourceEventId: 'not-found' },
  })
  assert.equal(projected.length, 2)
  assert.equal(projected[0].sourceEventId, 'u1')
  assert.equal(projected[1].sourceEventId, 'a1')
})

test('projectContextEvents incremental only slices native, keeps follow-up section untouched', () => {
  const events: EventEnvelope[] = [
    makeUser('u1', 'q1'),
    makeAssistant('a1', 'r1'),
    makeBoundary(),
    // followup_boundary 之后即便 sourceEventId 命中,也不作为 anchor:incremental 只裁原生段。
    { ...makeUser('trap', 'follow'), sourceEventId: 'a1' },
  ]
  const projected = projectContextEvents(events, {
    incremental: { summary: 's', upToSourceEventId: 'a1' },
  })
  // 命中的是原生段的 a1;follow-up 段那条 sourceEventId=a1 的 trap 不应被吞。
  assert.equal(projected[0].event.type, 'meta')
  assert.equal(projected[projected.length - 1].event.type, 'user_text')
})

test('projectContextEvents incremental with empty summary falls back to full', () => {
  const events: EventEnvelope[] = [makeUser('u1', 'q'), makeAssistant('a1', 'r')]
  const projected = projectContextEvents(events, {
    incremental: { summary: '   ', upToSourceEventId: 'u1' },
  })
  assert.equal(projected.length, 2)
  assert.equal(projected[0].sourceEventId, 'u1')
})
