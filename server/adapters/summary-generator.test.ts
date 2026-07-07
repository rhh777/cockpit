import { test } from 'node:test'
import assert from 'node:assert/strict'
import { heuristicSummaryGenerator } from './summary-generator'
import type { EventEnvelope } from '../loaders/types'

function nat(id: string, ev: EventEnvelope['event']): EventEnvelope {
  return { origin: 'native', source: 'claude-code', sourceEventId: id, event: ev }
}
function ck(id: string, ev: EventEnvelope['event']): EventEnvelope {
  return { origin: 'cockpit', source: 'claude-code', sourceEventId: id, event: ev }
}

test('heuristic summary: 抓初始目标、tool 计数、错误、anchor 指向原生段末尾', async () => {
  const events: EventEnvelope[] = [
    nat('u1', { type: 'user_text', text: '实现登录', ts: 't' }),
    nat('t1', { type: 'tool_use', id: 't1', name: 'Read', input: {}, ts: 't' }),
    nat('t1r', { type: 'tool_result', toolUseId: 't1', output: 'ok', isError: false, ts: 't' }),
    nat('t2', { type: 'tool_use', id: 't2', name: 'Bash', input: {}, ts: 't' }),
    nat('t2r', { type: 'tool_result', toolUseId: 't2', output: 'command failed', isError: true, ts: 't' }),
    nat('a1', { type: 'assistant_text', text: '进展汇报', agent: 'claude', ts: 't' }),
    ck('b', { type: 'followup_boundary', ts: 't' }),
    ck('f1', { type: 'user_text', text: 'follow-up 消息', ts: 't' }),
  ]

  const out = await heuristicSummaryGenerator.generate({ sourceId: 's', events })

  assert.match(out.markdown, /初始目标/)
  assert.match(out.markdown, /实现登录/)
  assert.match(out.markdown, /Read×1/)
  assert.match(out.markdown, /Bash×1/)
  assert.match(out.markdown, /command failed/)
  assert.match(out.markdown, /进展汇报/)
  assert.match(out.markdown, /follow-up 消息/)
  // anchor 指向原生段最后一条真实事件(a1),不落在 boundary/follow-up 上。
  assert.equal(out.anchorSourceEventId, 'a1')
  assert.equal(out.nativeEventCount, 6)
})

test('heuristic summary: 无原生事件时 anchor 未定,调用方可判断 skip', async () => {
  const events: EventEnvelope[] = [
    ck('b', { type: 'followup_boundary', ts: 't' }),
    ck('f1', { type: 'user_text', text: 'only follow-up', ts: 't' }),
  ]
  const out = await heuristicSummaryGenerator.generate({ sourceId: 's', events })
  assert.equal(out.anchorSourceEventId, undefined)
  assert.equal(out.nativeEventCount, 0)
})

test('heuristic summary: 屏蔽密钥泄漏进 summary', async () => {
  const events: EventEnvelope[] = [
    nat('u1', { type: 'user_text', text: 'aws_secret_access_key=AKIAIOSFODNN7EXAMPLE', ts: 't' }),
    nat('a1', { type: 'assistant_text', text: 'ok', agent: 'claude', ts: 't' }),
  ]
  const out = await heuristicSummaryGenerator.generate({ sourceId: 's', events })
  assert.doesNotMatch(out.markdown, /AKIAIOSFODNN7EXAMPLE/)
})
