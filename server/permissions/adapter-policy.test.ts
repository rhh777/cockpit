import test from 'node:test'
import assert from 'node:assert/strict'
import {
  claudePermissionArgs,
  codexGlobalArgsForPermissions,
  codexSandboxForPermissions,
  cursorPermissionArgs,
  openCodePermissionArgs,
  openCodePermissionRuleset,
} from './adapter-policy'
import { permissionsForMode } from './types'

test('Codex permissions map to sandbox and approval policy', () => {
  assert.equal(codexSandboxForPermissions(permissionsForMode('ask')), 'read-only')
  assert.deepEqual(codexGlobalArgsForPermissions(permissionsForMode('ask')), ['--ask-for-approval', 'never'])

  assert.equal(codexSandboxForPermissions(permissionsForMode('auto-safe')), 'workspace-write')
  assert.deepEqual(codexGlobalArgsForPermissions(permissionsForMode('auto-safe')), [
    '--ask-for-approval',
    'untrusted',
    '--search',
  ])

  assert.equal(codexSandboxForPermissions(permissionsForMode('full-access')), 'danger-full-access')
  assert.deepEqual(codexGlobalArgsForPermissions(permissionsForMode('full-access')), [
    '--dangerously-bypass-approvals-and-sandbox',
    '--search',
  ])
})

test('Claude permissions map to official permission modes', () => {
  assert.deepEqual(claudePermissionArgs(permissionsForMode('ask'), true), [
    '--permission-mode',
    'default',
    '--allowedTools',
    'Read,Grep,Glob',
  ])
  assert.deepEqual(claudePermissionArgs(permissionsForMode('auto-safe'), true), [
    '--permission-mode',
    'acceptEdits',
  ])
  assert.deepEqual(claudePermissionArgs(permissionsForMode('full-access'), true), [
    '--permission-mode',
    'bypassPermissions',
  ])
  assert.deepEqual(claudePermissionArgs(permissionsForMode('ask'), false), [
    '--permission-mode',
    'default',
    '--disallowedTools',
    'Bash,Edit,Write,MultiEdit,WebFetch,WebSearch',
  ])
})

test('Cursor and OpenCode permissions keep ask read-only and full access explicit', () => {
  assert.deepEqual(cursorPermissionArgs(permissionsForMode('ask')), ['--mode', 'ask'])
  assert.deepEqual(cursorPermissionArgs(permissionsForMode('auto-safe')), ['--auto-review', '--trust'])
  assert.deepEqual(cursorPermissionArgs(permissionsForMode('full-access')), ['--force', '--trust', '--sandbox', 'disabled'])

  assert.deepEqual(openCodePermissionArgs(permissionsForMode('ask')), ['--agent', 'plan'])
  assert.deepEqual(openCodePermissionArgs(permissionsForMode('auto-safe')), ['--agent', 'plan'])
  assert.deepEqual(openCodePermissionArgs(permissionsForMode('full-access')), ['--auto'])
})

test('OpenCode SDK permissions map to session rulesets', () => {
  assert.deepEqual(openCodePermissionRuleset(permissionsForMode('ask')), [
    { permission: 'read', pattern: '*', action: 'allow' },
    { permission: 'glob', pattern: '*', action: 'allow' },
    { permission: 'grep', pattern: '*', action: 'allow' },
    { permission: 'list', pattern: '*', action: 'allow' },
    { permission: 'todowrite', pattern: '*', action: 'allow' },
    { permission: '*', pattern: '*', action: 'ask' },
  ])
  assert.deepEqual(openCodePermissionRuleset(permissionsForMode('auto-safe')).slice(-4), [
    { permission: 'bash', pattern: '*', action: 'ask' },
    { permission: 'webfetch', pattern: '*', action: 'ask' },
    { permission: 'websearch', pattern: '*', action: 'ask' },
    { permission: '*', pattern: '*', action: 'ask' },
  ])
  assert.deepEqual(openCodePermissionRuleset(permissionsForMode('full-access')), [
    { permission: '*', pattern: '*', action: 'allow' },
  ])
})
