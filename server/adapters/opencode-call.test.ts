import assert from 'node:assert/strict'
import test from 'node:test'
import { _internal } from './opencode-call'

test('activeSessionMap unwraps OpenCode v2 active response envelope', () => {
  assert.deepEqual(_internal.activeSessionMap({ data: { ses_123: { status: 'running' } } }), {
    ses_123: { status: 'running' },
  })
})

test('activeSessionMap accepts legacy bare active maps', () => {
  assert.deepEqual(_internal.activeSessionMap({ ses_123: { status: 'running' } }), {
    ses_123: { status: 'running' },
  })
})
