import assert from 'node:assert/strict'
import test from 'node:test'
import { serialCompletionNotification } from './run-registry'

test('serial completion notification distinguishes consensus, disagreement limit, and user decision', () => {
  assert.match(serialCompletionNotification('consensus', 3), /达成一致/)
  assert.match(serialCompletionNotification('max-steps', 6), /分歧/)
  assert.match(serialCompletionNotification('no-next-agent', 2, 'blocked'), /需要你的决定/)
  assert.match(serialCompletionNotification('no-next-agent', 2, 'needs-changes'), /交回给你/)
})
