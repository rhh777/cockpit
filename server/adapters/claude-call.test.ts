import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import {
  __resetClaudeRuntimeCachesForTest,
  __setClaudeCommandExistsForTest,
  __setClaudeSdkImporterForTest,
  claudeAdapter,
  claudeAllowPermissionResult,
  claudeToolOperation,
  permissionUpdatesForApproval,
  warmupClaudeRuntime,
} from './claude-call'

afterEach(() => {
  __resetClaudeRuntimeCachesForTest()
})

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

test("permissionUpdatesForApproval scope 'once' 不下发 allow 规则,只补目录(docs/12 C2)", () => {
  const updates = permissionUpdatesForApproval(
    'Write',
    { kind: 'file_write', path: '~/Downloads/claude-hello.md', action: 'create' },
    undefined,
    [
      // SDK 建议的 allow 规则在 once 语义下也要被滤掉
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [{ toolName: 'Write' }],
      },
    ],
    'once',
  )
  assert.ok(updates)
  assert.equal(
    updates.some((u) => u.type === 'addRules' && u.behavior === 'allow'),
    false,
  )
  assert.deepEqual(
    updates.find((u) => u.type === 'addDirectories'),
    {
      type: 'addDirectories',
      destination: 'session',
      directories: [path.join(os.homedir(), 'Downloads')],
    },
  )
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

test('claudeAdapter.isAvailable caches successful CLI detection within TTL', async () => {
  let calls = 0
  __setClaudeCommandExistsForTest(async () => {
    calls += 1
    return true
  })

  assert.equal(await claudeAdapter.isAvailable(), true)
  assert.equal(await claudeAdapter.isAvailable(), true)
  assert.equal(calls, 1)
})

test('claudeAdapter.isAvailable does not long-cache failed CLI detection', async () => {
  let calls = 0
  __setClaudeCommandExistsForTest(async () => {
    calls += 1
    return calls > 1
  })

  assert.equal(await claudeAdapter.isAvailable(), false)
  assert.equal(await claudeAdapter.isAvailable(), true)
  assert.equal(calls, 2)
})

test('warmupClaudeRuntime caches Claude Agent SDK dynamic import promise', async () => {
  let imports = 0
  __setClaudeCommandExistsForTest(async () => true)
  __setClaudeSdkImporterForTest(async () => {
    imports += 1
    return { query: () => ({}) } as never
  })

  const [a, b] = await Promise.all([
    warmupClaudeRuntime({ includeSdk: true }),
    warmupClaudeRuntime({ includeSdk: true }),
  ])
  assert.deepEqual(a, { cliAvailable: true, sdkLoaded: true })
  assert.deepEqual(b, { cliAvailable: true, sdkLoaded: true })
  assert.equal(imports, 1)

  assert.deepEqual(await warmupClaudeRuntime({ includeSdk: true }), {
    cliAvailable: true,
    sdkLoaded: true,
  })
  assert.equal(imports, 1)
})

test('warmupClaudeRuntime reports SDK import errors without caching the failure forever', async () => {
  let imports = 0
  __setClaudeCommandExistsForTest(async () => true)
  __setClaudeSdkImporterForTest(async () => {
    imports += 1
    if (imports === 1) throw new Error('sdk unavailable')
    return { query: () => ({}) } as never
  })

  assert.deepEqual(await warmupClaudeRuntime({ includeSdk: true }), {
    cliAvailable: true,
    sdkLoaded: false,
    sdkError: 'sdk unavailable',
  })
  assert.deepEqual(await warmupClaudeRuntime({ includeSdk: true }), {
    cliAvailable: true,
    sdkLoaded: true,
  })
  assert.equal(imports, 2)
})
