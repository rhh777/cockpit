import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ServerResponse } from 'node:http'
import type { EventEnvelope } from '../loaders/types'
import type { RunRecord } from './run-store'
import { _internal, type RunStreamMessage } from './run-registry'

const { RunHandle } = _internal

function record(): RunRecord {
  return {
    runId: 'run_test',
    kind: 'followup',
    status: 'running',
    source: 'claude-code',
    sessionId: 'sess',
    turnId: 'turn_test',
    agent: 'claude',
    startedAt: new Date().toISOString(),
  }
}

function deltaMsg(streamId: string, text: string, id: string): RunStreamMessage {
  const envelope: EventEnvelope = {
    origin: 'cockpit',
    source: 'claude-code',
    sourceEventId: id,
    turnId: 'turn_test',
    runId: 'run_test',
    event: { type: 'assistant_text', text, ts: 't', agent: 'claude', streamId, delta: true },
  }
  return { kind: 'event', envelope }
}

function fakeRes(lines: string[]): ServerResponse {
  return {
    writableEnded: false,
    write(chunk: string) {
      lines.push(String(chunk))
      return true
    },
  } as unknown as ServerResponse
}

test('RunHandle replay 合并同 streamId 相邻 delta(docs/12 G1)', () => {
  const handle = new RunHandle(record())
  handle.write(deltaMsg('s1', '你', 'd1'))
  handle.write(deltaMsg('s1', '好', 'd2'))
  handle.write(deltaMsg('s1', '世界', 'd3'))

  assert.equal(handle.replay.length, 1)
  const only = handle.replay[0]
  assert.equal(only.kind, 'event')
  const ev = (only as Extract<RunStreamMessage, { kind: 'event' }>).envelope.event
  assert.equal(ev.type, 'assistant_text')
  assert.equal((ev as { text: string }).text, '你好世界')
  // 保留首个 delta 的 sourceEventId
  assert.equal((only as Extract<RunStreamMessage, { kind: 'event' }>).envelope.sourceEventId, 'd1')
})

test('RunHandle replay 不跨非 delta 事件、不跨 streamId 合并', () => {
  const handle = new RunHandle(record())
  handle.write(deltaMsg('s1', 'a', 'd1'))
  handle.write({ kind: 'run_phase', turnId: 'turn_test', runId: 'run_test', phase: 'streaming' })
  handle.write(deltaMsg('s1', 'b', 'd2')) // 中间隔了 run_phase,不并入 d1
  handle.write(deltaMsg('s2', 'c', 'd3')) // 不同 streamId,不并入 d2

  assert.equal(handle.replay.length, 4)
})

test('RunHandle 实时订阅者收到原始 delta 碎片,attach 重放收到合并结果', () => {
  const handle = new RunHandle(record())
  const liveLines: string[] = []
  const detach = handle.attach(fakeRes(liveLines))

  handle.write(deltaMsg('s1', 'foo', 'd1'))
  handle.write(deltaMsg('s1', 'bar', 'd2'))
  // 实时:两条独立 delta
  assert.equal(liveLines.length, 2)
  assert.match(liveLines[0], /"text":"foo"/)
  assert.match(liveLines[1], /"text":"bar"/)
  detach()

  // 重连:一条合并 delta
  const replayLines: string[] = []
  handle.attach(fakeRes(replayLines))
  assert.equal(replayLines.length, 1)
  assert.match(replayLines[0], /"text":"foobar"/)
})
