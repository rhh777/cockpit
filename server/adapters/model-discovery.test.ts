import assert from 'node:assert/strict'
import test from 'node:test'
import { parseClaudeEfforts, parseCursorModels } from './model-discovery'

test('parseCursorModels reads account model list and default marker', () => {
  assert.deepEqual(parseCursorModels(`Available models\nauto - Auto (current, default)\ngpt-5.6-sol-high - GPT-5.6 Sol High\n\nTip: use --model <id>`), [
    { value: 'auto', label: 'Auto', isDefault: true },
    { value: 'gpt-5.6-sol-high', label: 'GPT-5.6 Sol High' },
  ])
})

test('parseCursorModels does not treat Cursor credential errors as models', () => {
  assert.deepEqual(parseCursorModels('ERROR: SecItemCopyMatching failed -50\n'), [])
})

test('parseClaudeEfforts reads the installed CLI help contract', () => {
  assert.deepEqual(
    parseClaudeEfforts('  --effort <level>  Effort level for the current session (low, medium, high, xhigh, max)'),
    ['low', 'medium', 'high', 'xhigh', 'max'],
  )
})
