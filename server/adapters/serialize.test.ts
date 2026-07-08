import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serializeForAgent } from './serialize'
import { filterToolResult, redactSecrets, isSensitivePath } from './sensitive'
import type { EventEnvelope, Source } from '../loaders/types'

const SRC: Source = 'claude-code'
function nat(ev: EventEnvelope['event']): EventEnvelope {
  return { origin: 'native', source: SRC, event: ev }
}

test('serialize 钉住 User Goal + Final Response + Current Request', () => {
  const events: EventEnvelope[] = [
    nat({ type: 'user_text', text: '实现登录功能', ts: 't' }),
    nat({ type: 'assistant_text', text: '好的我来做', ts: 't' }),
    nat({ type: 'assistant_text', text: '已完成,测试通过', ts: 't' }),
  ]
  const out = serializeForAgent(events, '帮我 review', 'claude')
  assert.match(out, /## User Goal\n实现登录功能/)
  assert.match(out, /## Final Response\n已完成,测试通过/)
  assert.match(out, /# Current Request/)
  assert.match(out, /帮我 review/)
})

test('serialize 契约:contextEvents 不含当前请求,当前请求只出现在 Current Request', () => {
  // 调用方(run-registry)按 turnId 剔除当前轮后传入;serialize 不再做文本相等去重
  // (文本匹配在带附件或用户重复发同一句时会误判,docs/12 E2)。
  const events: EventEnvelope[] = [
    nat({ type: 'user_text', text: 'goal', ts: 't' }),
    nat({ type: 'assistant_text', text: 'done', ts: 't' }),
    { origin: 'cockpit', source: SRC, event: { type: 'followup_boundary', ts: 't' } },
    {
      origin: 'cockpit',
      source: SRC,
      turnId: 'turn_prev',
      event: { type: 'user_text', text: '上一轮的问题', ts: 't' },
    },
    {
      origin: 'cockpit',
      source: SRC,
      turnId: 'turn_prev',
      event: { type: 'assistant_text', text: '上一轮的回答', ts: 't' },
    },
  ]
  const out = serializeForAgent(events, '当前请求', 'codex')
  assert.equal(out.match(/当前请求/g)?.length, 1)
  // 历史 follow-up 轮次要完整保留
  assert.match(out, /上一轮的问题/)
  assert.match(out, /上一轮的回答/)
})

test('serialize 超长从中段截断,钉住部分保留', () => {
  const big = 'x'.repeat(50000)
  const events: EventEnvelope[] = [
    nat({ type: 'user_text', text: 'GOAL_PIN', ts: 't' }),
    nat({ type: 'assistant_text', text: big, ts: 't' }),
    nat({ type: 'assistant_text', text: 'FINAL_PIN', ts: 't' }),
  ]
  const out = serializeForAgent(events, 'REQ_PIN', 'claude', { maxChars: 4000 })
  assert.match(out, /GOAL_PIN/)
  assert.match(out, /FINAL_PIN/)
  assert.match(out, /REQ_PIN/)
  assert.match(out, /truncated/)
  assert.ok(out.length < 8000)
})

test('serialize 渲染 context_summary meta 为独立块', () => {
  const events: EventEnvelope[] = [
    {
      origin: 'cockpit',
      source: SRC,
      event: {
        type: 'meta',
        key: 'context_summary',
        value: { summary: 'earlier session gist here' },
        ts: 't',
      },
    },
    nat({ type: 'user_text', text: 'new question', ts: 't' }),
    nat({ type: 'assistant_text', text: 'answer', ts: 't' }),
  ]
  const out = serializeForAgent(events, 'follow up', 'claude')
  assert.match(out, /\[Session summary of earlier history\]/)
  assert.match(out, /earlier session gist here/)
})

test('redactSecrets 屏蔽密钥行,保留普通行', () => {
  const r = redactSecrets('normal line\naws_secret_access_key=AKIAIOSFODNN7EXAMPLE\nok')
  assert.match(r.text, /normal line/)
  assert.match(r.text, /已屏蔽/)
  assert.equal(r.redacted, true)
})

test('isSensitivePath 命中 .env / id_rsa / .ssh', () => {
  assert.equal(isSensitivePath('/proj/.env'), true)
  assert.equal(isSensitivePath('/home/u/.ssh/id_rsa'), true)
  assert.equal(isSensitivePath('/proj/src/app.ts'), false)
})

test('filterToolResult 敏感路径整体屏蔽', () => {
  const r = filterToolResult('SECRET=abcd', { file_path: '/proj/.env' })
  assert.match(r.text, /已屏蔽敏感内容/)
  assert.equal(r.redacted, true)
  const ok = filterToolResult('hello world', { file_path: '/proj/src/x.ts' })
  assert.equal(ok.text, 'hello world')
})

test('filterToolResult 命中 shell 命令中段的敏感路径 token', () => {
  // codex 的 command_execution 是整串命令,中段的 .env 也要拦住。
  const r = filterToolResult('SECRET=abcd', { command: 'cat /tmp/x/.env && echo done' })
  assert.match(r.text, /已屏蔽敏感内容/)
  const ok = filterToolResult('ok output', { command: 'ls -la /proj/src' })
  assert.equal(ok.text, 'ok output')
})
