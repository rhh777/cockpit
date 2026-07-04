import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { claudeAllowPermissionResult, claudeToolOperation, permissionUpdatesForApproval } from './claude-call'

test('claudeToolOperation maps write/edit/bash/network tools', () => {
  assert.deepEqual(claudeToolOperation('Write', { file_path: '/tmp/a.txt' }), {
    kind: 'file_write',
    path: '/tmp/a.txt',
    action: 'create',
  })
  assert.deepEqual(claudeToolOperation('Edit', { file_path: '/tmp/a.txt' }), {
    kind: 'file_write',
    path: '/tmp/a.txt',
    action: 'edit',
  })
  assert.deepEqual(claudeToolOperation('Bash', { command: 'npm test', cwd: '/tmp/project' }), {
    kind: 'shell',
    command: 'npm test',
    cwd: '/tmp/project',
  })
  assert.deepEqual(claudeToolOperation('WebFetch', { url: 'https://example.com' }), {
    kind: 'network',
    url: 'https://example.com',
  })
})

test('claudeToolOperation maps read/search tools', () => {
  assert.deepEqual(claudeToolOperation('Read', { file_path: '/tmp/a.txt' }), {
    kind: 'file_read',
    path: '/tmp/a.txt',
  })
  assert.deepEqual(claudeToolOperation('Grep', { path: '/tmp/project' }), {
    kind: 'file_read',
    path: '/tmp/project',
  })
  assert.equal(claudeToolOperation('UnknownTool', {}), null)
})

test('permissionUpdatesForApproval grants session directory for writes', () => {
  const updates = permissionUpdatesForApproval('Write', {
    kind: 'file_write',
    path: '~/Downloads/claude-hello.md',
    action: 'create',
  })
  assert.deepEqual(updates?.[0], {
    type: 'addRules',
    behavior: 'allow',
    destination: 'session',
    rules: [{ toolName: 'Write' }],
  })
  assert.deepEqual(updates?.[1], {
    type: 'addDirectories',
    destination: 'session',
    directories: [path.join(os.homedir(), 'Downloads')],
  })
})

test('permissionUpdatesForApproval preserves SDK suggestions and adds shell target directories', () => {
  const updates = permissionUpdatesForApproval(
    'Bash',
    {
      kind: 'shell',
      command: "printf 'hello' > ~/Downloads/claude.txt && ls -l ~/Downloads/claude.txt",
      cwd: '/tmp/project',
    },
    undefined,
    [
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [{ toolName: 'Bash', ruleContent: 'printf *' }],
      },
    ],
  )

  assert.deepEqual(updates?.[0], {
    type: 'addRules',
    behavior: 'allow',
    destination: 'session',
    rules: [{ toolName: 'Bash', ruleContent: 'printf *' }],
  })
  assert.deepEqual(updates?.[1], {
    type: 'addDirectories',
    destination: 'session',
    directories: ['/tmp/project', path.join(os.homedir(), 'Downloads')],
  })
})

test('claudeAllowPermissionResult includes updatedInput required by SDK runtime schema', () => {
  const toolInput = { file_path: '/tmp/a.txt', content: 'hello' }
  const result = claudeAllowPermissionResult(
    'Write',
    toolInput,
    { kind: 'file_write', path: '/tmp/a.txt', action: 'create' },
    { toolUseID: 'toolu_1' },
  )

  assert.equal(result.behavior, 'allow')
  assert.equal(result.toolUseID, 'toolu_1')
  assert.deepEqual(result.updatedInput, toolInput)
})
