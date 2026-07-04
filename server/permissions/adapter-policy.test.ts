import test from 'node:test'
import assert from 'node:assert/strict'
import {
  claudePermissionArgs,
  codexGlobalArgsForPermissions,
  codexSandboxForPermissions,
  cursorPermissionArgs,
  openCodePermissionArgs,
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
    'Read',
    'Grep',
    'Glob',
  ])
  assert.deepEqual(claudePermissionArgs(permissionsForMode('auto-safe'), true), [
    '--permission-mode',
    'auto',
    '--tools',
    'default',
  ])
  assert.deepEqual(claudePermissionArgs(permissionsForMode('full-access'), true), [
    '--permission-mode',
    'bypassPermissions',
    '--dangerously-skip-permissions',
    '--tools',
    'default',
  ])
})

test('Cursor and OpenCode permissions keep ask read-only and full access explicit', () => {
  assert.deepEqual(cursorPermissionArgs(permissionsForMode('ask')), ['--mode', 'ask'])
  assert.deepEqual(cursorPermissionArgs(permissionsForMode('auto-safe')), ['--auto-review', '--trust'])
  assert.deepEqual(cursorPermissionArgs(permissionsForMode('full-access')), ['--force', '--trust', '--sandbox', 'disabled'])

  assert.deepEqual(openCodePermissionArgs(permissionsForMode('ask')), ['--agent', 'plan'])
  assert.deepEqual(openCodePermissionArgs(permissionsForMode('auto-safe')), ['--agent', 'plan'])
  assert.deepEqual(openCodePermissionArgs(permissionsForMode('full-access')), ['--dangerously-skip-permissions'])
})
