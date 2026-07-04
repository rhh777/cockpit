import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codexThreadSettings, mapCodexApprovalRequest, translateNotification } from './codex-app-server'

test('translateNotification: item/completed agentMessage -> assistant_text', () => {
  const events = translateNotification(
    'item/completed',
    { item: { type: 'agentMessage', id: 'a1', text: 'hello' } },
    'thread_1',
  )
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'assistant_text')
  if (events[0].type === 'assistant_text') {
    assert.equal(events[0].text, 'hello')
    assert.equal(events[0].agent, 'codex')
    assert.equal(events[0].streamId, 'a1')
  }
})

test('translateNotification: item/agentMessage/delta -> assistant_text delta', () => {
  const events = translateNotification(
    'item/agentMessage/delta',
    { threadId: 't', turnId: 'u', itemId: 'i', delta: 'chunk' },
    't',
  )
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'assistant_text')
  if (events[0].type === 'assistant_text') {
    assert.equal(events[0].delta, true)
    assert.equal(events[0].text, 'chunk')
    assert.equal(events[0].streamId, 'i')
  }
})

test('translateNotification: item/started commandExecution -> tool_use', () => {
  const events = translateNotification(
    'item/started',
    { item: { type: 'commandExecution', id: 'c1', command: 'ls' } },
    't',
  )
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'tool_use')
  if (events[0].type === 'tool_use') {
    assert.equal(events[0].name, 'shell')
    assert.deepEqual(events[0].input, { command: 'ls' })
  }
})

test('translateNotification: item/completed commandExecution -> tool_use + tool_result', () => {
  const events = translateNotification(
    'item/completed',
    {
      item: {
        type: 'commandExecution',
        id: 'c1',
        command: 'ls',
        status: 'completed',
        aggregatedOutput: 'a\nb',
        exitCode: 0,
      },
    },
    't',
  )
  assert.equal(events.length, 2)
  assert.equal(events[0].type, 'tool_use')
  assert.equal(events[1].type, 'tool_result')
  if (events[1].type === 'tool_result') {
    assert.equal(events[1].isError, false)
    assert.equal(events[1].output, 'a\nb')
  }
})

test('translateNotification: turn/completed with tokenUsage -> usage', () => {
  const events = translateNotification(
    'turn/completed',
    { threadId: 't', turn: { id: 'u', tokenUsage: { inputTokens: 5, outputTokens: 3 } } },
    't',
  )
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'usage')
  if (events[0].type === 'usage') {
    assert.equal(events[0].inputTokens, 5)
    assert.equal(events[0].outputTokens, 3)
  }
})

test('translateNotification: unknown method -> []', () => {
  assert.deepEqual(translateNotification('some/random', {}, 't'), [])
})

test('mapCodexApprovalRequest: modern command approval', () => {
  const mapping = mapCodexApprovalRequest('item/commandExecution/requestApproval', {
    command: 'npm test',
    cwd: '/tmp/project',
    reason: 'Run tests',
  })
  assert.ok(mapping)
  assert.deepEqual(mapping.operation, { kind: 'shell', command: 'npm test', cwd: '/tmp/project' })
  assert.equal(mapping.reason, 'Run tests')
  assert.deepEqual(mapping.responseFor('approved'), { result: { decision: 'accept' } })
  assert.deepEqual(mapping.responseFor('rejected'), { result: { decision: 'decline' } })
})

test('mapCodexApprovalRequest: legacy apply patch approval', () => {
  const mapping = mapCodexApprovalRequest('applyPatchApproval', {
    fileChanges: {
      '/tmp/project/a.txt': { type: 'add', content: 'hello' },
    },
  })
  assert.ok(mapping)
  assert.deepEqual(mapping.operation, { kind: 'file_write', path: '/tmp/project/a.txt', action: 'create' })
  assert.deepEqual(mapping.responseFor('approved'), { result: { decision: 'approved' } })
  assert.deepEqual(mapping.responseFor('rejected'), { result: { decision: 'denied' } })
})

test('codexThreadSettings maps permission modes to app-server settings', () => {
  assert.deepEqual(codexThreadSettings({ mode: 'ask', cwd: '/tmp/project' }), {
    cwd: '/tmp/project',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
  })
  assert.equal(codexThreadSettings({ mode: 'auto-safe' }).approvalsReviewer, 'auto_review')
  assert.deepEqual(codexThreadSettings({ mode: 'full-access' }).sandboxPolicy, { type: 'dangerFullAccess' })
})
