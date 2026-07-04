import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { claudeLoader, normalizeClaudeLine } from './claude-loader'
import { codexLoader, normalizeCodexLine, resolveCodexUpdatedAt, summarizeCodexFile } from './codex-loader'
import type { NormalizedEvent } from './types'

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../__fixtures__')

function types(events: { event: NormalizedEvent }[]): string[] {
  return events.map((e) => e.event.type)
}

test('claude loader: best-effort, normalizes core event types', async () => {
  const { events, warnings, summaryPatch } = await claudeLoader.loadEvents(
    path.join(FIX, 'claude-sample.jsonl'),
  )
  const t = types(events)
  // queue-operation 被跳过;thinking/text/tool_use 拆开;tool_result 提取;未知 type 降级 meta
  assert.ok(t.includes('user_text'))
  assert.ok(t.includes('thinking'))
  assert.ok(t.includes('assistant_text'))
  assert.ok(t.includes('tool_use'))
  assert.ok(t.includes('tool_result'))
  assert.ok(t.includes('usage'))
  assert.ok(t.includes('meta'), 'unknown type degrades to meta')
  // 坏 JSON 行不致命,记录 warning(不变量 5)
  assert.ok(warnings.some((w) => w.code === 'json_parse_failed'))
  assert.equal(summaryPatch.cwd, '/Users/demo/proj')

  const tr = events.find((e) => e.event.type === 'tool_result')
  assert.ok(tr && tr.event.type === 'tool_result' && tr.event.output.includes('export const x'))

  const tu = events.find((e) => e.event.type === 'tool_use')
  assert.ok(tu && tu.event.type === 'tool_use' && tu.event.name === 'Read')
})

test('claude loader: user image content blocks become attachments', () => {
  const events = normalizeClaudeLine({
    type: 'user',
    timestamp: '2026-07-04T00:00:00.000Z',
    message: {
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'aGVsbG8=',
          },
        },
        { type: 'text', text: '看这张图' },
      ],
    },
  })

  assert.equal(events.length, 1)
  const ev = events[0]
  assert.equal(ev.type, 'user_text')
  if (ev.type !== 'user_text') return
  assert.equal(ev.text, '看这张图')
  assert.equal(ev.attachments?.[0]?.kind, 'image')
  assert.equal(ev.attachments?.[0]?.mimeType, 'image/png')
  assert.equal(ev.attachments?.[0]?.dataUrl, 'data:image/png;base64,aGVsbG8=')
})

test('codex loader: payload.type keying, arguments parse, output prefix strip', async () => {
  const { events, summaryPatch } = await codexLoader.loadEvents(
    path.join(FIX, 'codex-sample.jsonl'),
  )
  const t = types(events)
  assert.ok(t.includes('user_text'))
  assert.ok(t.includes('tool_use'))
  assert.ok(t.includes('tool_result'))
  assert.ok(t.includes('assistant_text'))
  // session_meta / developer message / empty reasoning 不入 timeline
  assert.equal(summaryPatch.cwd, '/Users/demo/proj')

  const tu = events.find((e) => e.event.type === 'tool_use')
  assert.ok(tu && tu.event.type === 'tool_use')
  // arguments 字符串被 JSON.parse 一次
  assert.deepEqual((tu!.event as any).input, { cmd: 'ls', workdir: '/Users/demo/proj' })
  assert.equal(tu!.event.type === 'tool_use' && tu!.event.id, 'call_a')

  const tr = events.find((e) => e.event.type === 'tool_result')
  assert.ok(tr && tr.event.type === 'tool_result')
  // Codex metadata 前缀剥离,只留 Output: 之后
  assert.equal((tr!.event as any).output, 'a.ts\nb.ts')

  const am = events.find((e) => e.event.type === 'assistant_text')
  assert.ok(am && am.event.type === 'assistant_text' && am.event.agent === 'codex')

  assert.equal(summaryPatch.title, '列一下文件')
})

test('codex loader: user images become attachments', async () => {
  const tmpImage = '/var/folders/demo/codex-clipboard-demo.png'
  const normalized = normalizeCodexLine({
    timestamp: '2026-07-04T00:00:00.000Z',
    payload: {
      type: 'user_message',
      message: `Files mentioned by the user:\n${tmpImage}\n请看图`,
      images: [tmpImage],
    },
  })
  const ev = normalized[0]
  assert.equal(ev.type, 'user_text')
  if (ev.type !== 'user_text') return
  assert.equal(ev.text, '请看图')
  assert.equal(ev.attachments?.[0]?.kind, 'image')
  assert.equal(ev.attachments?.[0]?.path, tmpImage)
  assert.equal(ev.attachments?.[0]?.mimeType, 'image/png')
})

test('codex loader: fallback summary title comes from first user message', async () => {
  const patch = await summarizeCodexFile(path.join(FIX, 'codex-sample.jsonl'))

  assert.equal(patch.title, '列一下文件')
  assert.equal(patch.cwd, '/Users/demo/proj')
  assert.equal(patch.startedAt, '2026-06-16T08:00:00.000Z')
})

test('codex loader: indexed sessions still get cwd from file header', async () => {
  const patch = await summarizeCodexFile(path.join(FIX, 'codex-sample.jsonl'), 20, false)

  assert.equal(patch.title, undefined)
  assert.equal(patch.cwd, '/Users/demo/proj')
  assert.equal(patch.startedAt, '2026-06-16T08:00:00.000Z')
})

test('codex loader: updatedAt uses file mtime when session index is stale', () => {
  const fileMtimeMs = Date.parse('2026-06-29T03:41:41.000Z')

  assert.equal(
    resolveCodexUpdatedAt('2026-06-26T09:51:49.225706Z', fileMtimeMs),
    '2026-06-29T03:41:41.000Z',
  )
  assert.equal(
    resolveCodexUpdatedAt('2026-06-30T09:51:49.225Z', fileMtimeMs),
    '2026-06-30T09:51:49.225Z',
  )
})

test('codex loader: agent_message_delta carries streamId/delta for UI merge', async () => {
  const { events } = await codexLoader.loadEvents(path.join(FIX, 'codex-sample.jsonl'))
  const deltas = events.filter(
    (e) => e.event.type === 'assistant_text' && (e.event as any).delta === true,
  )
  assert.equal(deltas.length, 2, 'two delta events surfaced')
  for (const d of deltas) {
    if (d.event.type !== 'assistant_text') continue
    assert.equal(d.event.streamId, 'msg_b')
    assert.equal(d.event.agent, 'codex')
  }
})

test('codex loader: exec_command_begin/end map to tool_use/tool_result', async () => {
  const { events } = await codexLoader.loadEvents(path.join(FIX, 'codex-sample.jsonl'))
  const shellUse = events.find(
    (e) => e.event.type === 'tool_use' && e.event.name === 'shell',
  )
  const shellResult = events.find(
    (e) => e.event.type === 'tool_result' && e.event.toolUseId === 'call_b',
  )
  assert.ok(shellUse, 'shell tool_use surfaced')
  assert.ok(shellResult, 'shell tool_result surfaced')
  if (shellResult && shellResult.event.type === 'tool_result') {
    assert.equal(shellResult.event.output, 'hi\n')
    assert.equal(shellResult.event.isError, false)
  }
})
