import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSerialDirective, selectNextAgentFromDirective } from './serial-directive'

test('parseSerialDirective: reads terminal Next and Status block', () => {
  assert.deepEqual(parseSerialDirective('Looks good.\n\nNext: @codex\nStatus: needs-review'), {
    ok: true,
    next: 'codex',
    status: 'needs-review',
  })
  assert.deepEqual(parseSerialDirective('Done.\nNext： @user\nStatus： consensus'), {
    ok: true,
    next: '@user',
    status: 'consensus',
  })
  assert.deepEqual(parseSerialDirective('Next: @codex Status: needs-review'), {
    ok: true,
    next: 'codex',
    status: 'needs-review',
  })
})

test('parseSerialDirective: ignores prose mentions and fenced examples', () => {
  assert.equal(parseSerialDirective('I disagree with @codex here.').ok, false)
  assert.equal(
    parseSerialDirective('```text\nNext: @codex\nStatus: needs-review\n```\nNo directive.').ok,
    false,
  )
})

test('parseSerialDirective: rejects invalid protocol', () => {
  assert.equal(parseSerialDirective('Next: @codex @claude\nStatus: needs-review').error, 'multiple-next')
  assert.deepEqual(parseSerialDirective('Next: @codex\nStatus: consensus'), {
    ok: true,
    next: '@user',
    status: 'consensus',
  })
  assert.equal(parseSerialDirective('Next: @user\nStatus: maybe').error, 'invalid-status')
})

test('selectNextAgentFromDirective: constrains participants and self mentions', () => {
  const directive = parseSerialDirective('Next: @codex\nStatus: needs-review')
  assert.equal(selectNextAgentFromDirective(directive, ['claude', 'codex'], 'claude'), 'codex')
  assert.equal(selectNextAgentFromDirective(directive, ['claude'], 'claude'), null)
  assert.equal(selectNextAgentFromDirective(directive, ['claude', 'codex'], 'codex'), null)
})
