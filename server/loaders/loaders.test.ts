import { test } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { claudeLoader, normalizeClaudeLine } from './claude-loader'
import { codexLoader, normalizeCodexLine, resolveCodexUpdatedAt, summarizeCodexFile } from './codex-loader'
import { opencodeLoader } from './opencode-loader'
import { cursorLoader, normalizeCursorTranscriptLine } from './cursor-loader'
import type { NormalizedEvent } from './types'

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../__fixtures__')
const execFileAsync = promisify(execFile)
const HAS_SQLITE = spawnSync('sqlite3', ['-version'], { stdio: 'ignore' }).status === 0

function types(events: { event: NormalizedEvent }[]): string[] {
  return events.map((e) => e.event.type)
}

function tempJsonl(name: string): string {
  return path.join(os.tmpdir(), `cockpit-loader-${name}-${randomUUID()}.jsonl`)
}

function tempDb(name: string): string {
  return path.join(os.tmpdir(), `cockpit-loader-${name}-${randomUUID()}.db`)
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function sqliteExec(dbPath: string, sql: string) {
  await execFileAsync('sqlite3', [dbPath, sql])
}

async function rmQuiet(filePath: string) {
  await fsp.rm(filePath, { force: true })
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

test('cursor loader: transcript roles normalize into native timeline events', async () => {
  const file = tempJsonl('cursor-transcript')
  await fsp.writeFile(
    file,
    [
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '你好' }] } }),
      JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: '你好，我是 Cursor。' }] } }),
      JSON.stringify({ type: 'turn_ended', status: 'completed' }),
      '{bad json',
    ].join('\n'),
  )
  try {
    const result = await cursorLoader.loadEvents(file, '11111111-1111-4111-8111-111111111111')
    assert.deepEqual(types(result.events), ['user_text', 'assistant_text', 'meta'])
    assert.equal(result.summaryPatch.messageCount, 2)
    assert.equal(result.warnings[0]?.code, 'json_parse_failed')
    const assistant = result.events[1]?.event
    assert.equal(assistant.type, 'assistant_text')
    if (assistant.type === 'assistant_text') {
      assert.equal(assistant.agent, 'cursor')
      assert.equal(assistant.text, '你好，我是 Cursor。')
    }
  } finally {
    await rmQuiet(file)
  }
})

test('cursor loader: assistant thinking and tool calls are preserved', () => {
  const events = normalizeCursorTranscriptLine(
    {
      role: 'assistant',
      message: {
        content: [
          { type: 'thinking', text: '分析' },
          { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'a.ts' } },
        ],
      },
    },
    '2026-08-01T00:00:00.000Z',
  )
  assert.deepEqual(events.map((event) => event.type), ['thinking', 'tool_use'])
})

test('cursor loader: 用户消息剥掉 <timestamp>/<user_query> 包装并采用真实时间', async () => {
  const file = tempJsonl('cursor-wrapped')
  await fsp.writeFile(
    file,
    [
      JSON.stringify({
        role: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: '<timestamp>Saturday, Aug 1, 2026, 4:07 PM (UTC+8)</timestamp>\n<user_query>\nhello\n</user_query>',
            },
          ],
        },
      }),
      JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: '你好' }] } }),
    ].join('\n'),
  )
  try {
    const result = await cursorLoader.loadEvents(file, '22222222-2222-4222-8222-222222222222')
    const user = result.events[0]?.event
    assert.equal(user.type, 'user_text')
    if (user.type === 'user_text') assert.equal(user.text, 'hello')
    assert.equal(user.ts, '2026-08-01T08:07:00.000Z')
    assert.equal(result.events[1]?.event.ts, '2026-08-01T08:07:00.001Z')
  } finally {
    await rmQuiet(file)
  }
})

test('cursor loader: 只有上下文块、没有真实输入的用户行不进 timeline', () => {
  const events = normalizeCursorTranscriptLine(
    {
      role: 'user',
      message: {
        content: [{ type: 'text', text: '<timestamp>Saturday, Aug 1, 2026, 4:07 PM (UTC+8)</timestamp>\n<additional_data>ctx</additional_data>' }],
      },
    },
    '2026-08-01T00:00:00.000Z',
  )
  assert.deepEqual(events, [])
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

test('opencode loader: session_message rows normalize into timeline events', { skip: !HAS_SQLITE }, async () => {
  const db = tempDb('opencode-session-message')
  const id = 'ses_testSessionMessage123'
  try {
    await sqliteExec(
      db,
      [
        'create table session (id text primary key, title text, directory text, time_created integer, time_updated integer, agent text, model text);',
        'create table session_message (id text primary key, session_id text, type text, time_created integer, time_updated integer, data text, seq integer);',
        `insert into session values (${sqlString(id)}, 'Greeting', '/tmp/project', 1783755000000, 1783755005000, 'build', ${sqlString(JSON.stringify({ id: 'glm-5.2', providerID: 'xingliu' }))});`,
        `insert into session_message values ('m1', ${sqlString(id)}, 'user', 1783755000000, 1783755000000, ${sqlString(JSON.stringify({ time: { created: 1783755000000 }, text: 'hello' }))}, 1);`,
        `insert into session_message values ('m2', ${sqlString(id)}, 'assistant', 1783755001000, 1783755002000, ${sqlString(JSON.stringify({ time: { created: 1783755001000 }, content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'hi there' }, { type: 'step-finish', tokens: { input: 3, output: 2 } }] }))}, 2);`,
      ].join('\n'),
    )

    const { events, summaryPatch, warnings } = await opencodeLoader.loadEvents(db, id)
    assert.deepEqual(warnings, [])
    assert.equal(summaryPatch.title, 'Greeting')
    assert.equal(summaryPatch.cwd, '/tmp/project')
    assert.equal(summaryPatch.messageCount, 2)
    assert.deepEqual(types(events), ['user_text', 'thinking', 'assistant_text', 'usage'])
    const assistant = events.find((e) => e.event.type === 'assistant_text')
    assert.ok(assistant?.event.type === 'assistant_text' && assistant.event.agent === 'opencode')
  } finally {
    await rmQuiet(db)
  }
})

test('opencode loader: legacy message/part rows are used when session_message is empty', { skip: !HAS_SQLITE }, async () => {
  const db = tempDb('opencode-legacy')
  const id = 'ses_testLegacy123'
  try {
    await sqliteExec(
      db,
      [
        'create table session (id text primary key, title text, directory text, time_created integer, time_updated integer, agent text, model text);',
        'create table session_message (id text primary key, session_id text, type text, time_created integer, time_updated integer, data text, seq integer);',
        'create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text);',
        'create table part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text);',
        `insert into session values (${sqlString(id)}, '', '/tmp/legacy', 1783755100000, 1783755105000, 'build', '');`,
        `insert into message values ('msg_user', ${sqlString(id)}, 1783755100000, 1783755100000, ${sqlString(JSON.stringify({ role: 'user' }))});`,
        `insert into part values ('prt_user', 'msg_user', ${sqlString(id)}, 1783755100000, 1783755100000, ${sqlString(JSON.stringify({ type: 'text', text: 'who are you' }))});`,
        `insert into message values ('msg_assistant', ${sqlString(id)}, 1783755101000, 1783755102000, ${sqlString(JSON.stringify({ role: 'assistant' }))});`,
        `insert into part values ('prt_assistant', 'msg_assistant', ${sqlString(id)}, 1783755101000, 1783755102000, ${sqlString(JSON.stringify({ type: 'text', text: 'I am OpenCode' }))});`,
      ].join('\n'),
    )

    const { events, summaryPatch } = await opencodeLoader.loadEvents(db, id)
    assert.equal(summaryPatch.title, 'who are you')
    assert.equal(summaryPatch.messageCount, 2)
    assert.deepEqual(types(events), ['user_text', 'assistant_text'])
  } finally {
    await rmQuiet(db)
  }
})

test('opencode loader: session_message and legacy message/part rows are merged by time', { skip: !HAS_SQLITE }, async () => {
  const db = tempDb('opencode-mixed')
  const id = 'ses_testMixed123'
  try {
    await sqliteExec(
      db,
      [
        'create table session (id text primary key, title text, directory text, time_created integer, time_updated integer, agent text, model text);',
        'create table session_message (id text primary key, session_id text, type text, time_created integer, time_updated integer, data text, seq integer);',
        'create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text);',
        'create table part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text);',
        `insert into session values (${sqlString(id)}, '', '/tmp/mixed', 1783755200000, 1783755205000, 'build', '');`,
        `insert into session_message values ('sm1', ${sqlString(id)}, 'user', 1783755200000, 1783755200000, ${sqlString(JSON.stringify({ time: { created: 1783755200000 }, text: 'old hello' }))}, 1);`,
        `insert into message values ('msg_user_new', ${sqlString(id)}, 1783755206000, 1783755206000, ${sqlString(JSON.stringify({ role: 'user' }))});`,
        `insert into part values ('prt_user_new', 'msg_user_new', ${sqlString(id)}, 1783755206000, 1783755206000, ${sqlString(JSON.stringify({ type: 'text', text: 'new hello' }))});`,
        `insert into message values ('msg_assistant_new', ${sqlString(id)}, 1783755207000, 1783755208000, ${sqlString(JSON.stringify({ role: 'assistant' }))});`,
        `insert into part values ('prt_assistant_new', 'msg_assistant_new', ${sqlString(id)}, 1783755207000, 1783755208000, ${sqlString(JSON.stringify({ type: 'text', text: 'new reply' }))});`,
      ].join('\n'),
    )

    const { events, summaryPatch } = await opencodeLoader.loadEvents(db, id)
    assert.equal(summaryPatch.title, 'old hello')
    assert.equal(summaryPatch.messageCount, 3)
    assert.deepEqual(types(events), ['user_text', 'user_text', 'assistant_text'])
    assert.ok(events[0]?.event.type === 'user_text' && events[0].event.text === 'old hello')
    assert.ok(events[1]?.event.type === 'user_text' && events[1].event.text === 'new hello')
  } finally {
    await rmQuiet(db)
  }
})

test('claude loader: incremental append ids match full parse', async () => {
  const file = tempJsonl('claude-inc')
  const line1 = JSON.stringify({
    type: 'user',
    uuid: 'u1',
    timestamp: '2026-07-10T00:00:00.000Z',
    message: { content: 'hello' },
  })
  const line2 = JSON.stringify({
    type: 'assistant',
    uuid: 'a1',
    parentUuid: 'u1',
    timestamp: '2026-07-10T00:00:01.000Z',
    message: { content: [{ type: 'text', text: 'hi' }] },
  })

  try {
    await fsp.writeFile(file, `${line1}\n`, 'utf8')
    const first = await claudeLoader.loadEventsFrom!(file, { byteOffset: 0, lineNo: 0 })
    await fsp.appendFile(file, `${line2}\n`, 'utf8')
    const inc = await claudeLoader.loadEventsFrom!(file, first.state)
    const full = await claudeLoader.loadEvents(file)

    assert.deepEqual(
      [...first.events, ...inc.events].map((e) => e.sourceEventId),
      full.events.map((e) => e.sourceEventId),
    )
  } finally {
    await rmQuiet(file)
  }
})

test('codex loader: incremental seq stays file-wide across appended lines', async () => {
  const file = tempJsonl('codex-inc')
  const line1 = JSON.stringify({
    type: 'event_msg',
    timestamp: '2026-07-10T00:00:00.000Z',
    payload: { type: 'user_message', message: 'hello' },
  })
  const line2 = JSON.stringify({
    type: 'event_msg',
    timestamp: '2026-07-10T00:00:01.000Z',
    payload: { type: 'agent_message_delta', item_id: 'msg1', delta: 'h' },
  })
  const line3 = JSON.stringify({
    type: 'event_msg',
    timestamp: '2026-07-10T00:00:02.000Z',
    payload: { type: 'agent_message', message: 'hi' },
  })

  try {
    await fsp.writeFile(file, `${line1}\n`, 'utf8')
    const first = await codexLoader.loadEventsFrom!(file, { byteOffset: 0, lineNo: 0, seq: 0 })
    await fsp.appendFile(file, `${line2}\n${line3}\n`, 'utf8')
    const inc = await codexLoader.loadEventsFrom!(file, first.state)
    const full = await codexLoader.loadEvents(file)

    assert.deepEqual(
      [...first.events, ...inc.events].map((e) => e.sourceEventId),
      full.events.map((e) => e.sourceEventId),
    )
    assert.deepEqual(
      full.events.map((e) => e.sourceEventId),
      [`${path.basename(file)}#1#0`, `${path.basename(file)}#2#1`, `${path.basename(file)}#3#2`],
    )
  } finally {
    await rmQuiet(file)
  }
})

test('incremental jsonl: EOF half-line waits for completion without warning or offset advance', async () => {
  const file = tempJsonl('half-line')
  const line1 = JSON.stringify({
    type: 'user',
    uuid: 'u1',
    timestamp: '2026-07-10T00:00:00.000Z',
    message: { content: 'hello' },
  })
  const line2 = JSON.stringify({
    type: 'assistant',
    uuid: 'a1',
    timestamp: '2026-07-10T00:00:01.000Z',
    message: { content: [{ type: 'text', text: 'done' }] },
  })

  try {
    await fsp.writeFile(file, `${line1}\n`, 'utf8')
    const first = await claudeLoader.loadEventsFrom!(file, { byteOffset: 0, lineNo: 0 })
    await fsp.appendFile(file, line2.slice(0, 20), 'utf8')
    const half = await claudeLoader.loadEventsFrom!(file, first.state)
    assert.equal(half.events.length, 0)
    assert.equal(half.warnings.length, 0)
    assert.equal(half.state.byteOffset, first.state.byteOffset)
    assert.ok(half.state.pending)

    await fsp.appendFile(file, `${line2.slice(20)}\n`, 'utf8')
    const complete = await claudeLoader.loadEventsFrom!(file, half.state)
    assert.equal(complete.events.length, 1)
    assert.equal(complete.events[0].sourceEventId, 'a1:assistant_text')
  } finally {
    await rmQuiet(file)
  }
})
