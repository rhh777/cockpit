import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { EventEnvelope } from '../loaders/types'
import { extractIssuesForRound, parseFindingsBlock } from './extract-issues'

test('parseFindingsBlock: object with issues + agreements', () => {
  const text = [
    'Some prose review here.',
    '',
    'FINDINGS',
    '```json',
    '{',
    '  "issues": [',
    '    {"title": "Missing null check", "severity": "major", "path": "src/a.ts", "line": 42, "body": "explain"},',
    '    {"title": "Nit: naming", "severity": "nit", "body": "rename foo"}',
    '  ],',
    '  "agreements": ["module boundaries"],',
    '  "disagreements": [],',
    '  "next": "fix"',
    '}',
    '```',
  ].join('\n')
  const parsed = parseFindingsBlock(text)
  assert.ok(parsed)
  assert.equal(parsed!.issues.length, 2)
  assert.equal(parsed!.issues[0].title, 'Missing null check')
  assert.equal(parsed!.issues[0].severity, 'major')
  assert.equal(parsed!.issues[0].line, 42)
  assert.deepEqual(parsed!.agreements, ['module boundaries'])
  assert.equal(parsed!.recommendedNextStep, 'fix')
})

test('parseFindingsBlock: bare array in a plain fence', () => {
  const text = 'FINDINGS\n```\n[{"title":"X","severity":"blocker","body":"y"}]\n```'
  const parsed = parseFindingsBlock(text)
  assert.ok(parsed)
  assert.equal(parsed!.issues[0].title, 'X')
  assert.equal(parsed!.issues[0].severity, 'blocker')
})

test('parseFindingsBlock: normalizes unknown severity to minor', () => {
  const text = '```json\n[{"title":"X","severity":"WARN","body":"y"}]\n```'
  const parsed = parseFindingsBlock(text)
  assert.equal(parsed?.issues[0].severity, 'minor')
})

test('parseFindingsBlock: returns null when no fence and no findings label', () => {
  assert.equal(parseFindingsBlock('just prose, nothing structured'), null)
})

test('parseFindingsBlock: recovers from trailing garbage after last close brace', () => {
  const text = 'FINDINGS\n```json\n{"issues":[{"title":"X","body":"y"}]}\nrandom trailing junk\n```'
  const parsed = parseFindingsBlock(text)
  assert.ok(parsed)
  assert.equal(parsed!.issues[0].title, 'X')
})

test('extractIssuesForRound: buckets by agent and namespaces ids', () => {
  const events: EventEnvelope[] = [
    {
      origin: 'cockpit',
      source: 'cockpit',
      turnId: 'g1',
      event: {
        type: 'assistant_text',
        agent: 'claude',
        text: 'prose\nFINDINGS\n```json\n[{"title":"A","body":"b"}]\n```',
        ts: '2026-07-21T00:00:00Z',
      },
    },
    {
      origin: 'cockpit',
      source: 'cockpit',
      turnId: 'g1',
      event: {
        type: 'assistant_text',
        agent: 'codex',
        text: 'prose\nFINDINGS\n```json\n[{"title":"B","severity":"major","body":"b"}]\n```',
        ts: '2026-07-21T00:00:01Z',
      },
    },
    // other turn — must be ignored
    {
      origin: 'cockpit',
      source: 'cockpit',
      turnId: 'g2',
      event: {
        type: 'assistant_text',
        agent: 'claude',
        text: 'FINDINGS\n```json\n[{"title":"C","body":"c"}]\n```',
        ts: '2026-07-21T00:00:02Z',
      },
    },
  ] as unknown as EventEnvelope[]
  const out = extractIssuesForRound(events, 'g1')
  assert.equal(out.issues.length, 2)
  assert.deepEqual(
    out.issues.map((i) => i.id),
    ['claude-1', 'codex-1'],
  )
  const byAgent = new Map(out.issues.map((i) => [i.agent, i.title]))
  assert.equal(byAgent.get('claude'), 'A')
  assert.equal(byAgent.get('codex'), 'B')
})

test('parseFindingsBlock: results branch normalises outcome and refIssueId', () => {
  const text = [
    'Fix round result.',
    '',
    'FINDINGS',
    '```json',
    '{"results":[',
    '  {"refIssueId":"claude-1","outcome":"FIXED","note":"tightened validation"},',
    '  {"refIssueId":"codex-2","outcome":"needs_discussion","note":"scope unclear"}',
    '],"issues":[],"next":"verify"}',
    '```',
  ].join('\n')
  const parsed = parseFindingsBlock(text)
  assert.ok(parsed)
  assert.equal(parsed!.issues.length, 2)
  assert.deepEqual(parsed!.issues[0].refIssueIds, ['claude-1'])
  assert.equal(parsed!.issues[0].outcome, 'verified')
  assert.equal(parsed!.issues[1].outcome, 'needs-discussion')
  assert.equal(parsed!.recommendedNextStep, 'verify')
})

test('extractIssuesForRound: skips delta assistant_text', () => {
  const events: EventEnvelope[] = [
    {
      origin: 'cockpit',
      source: 'cockpit',
      turnId: 'g1',
      event: {
        type: 'assistant_text',
        agent: 'claude',
        delta: true,
        text: 'partial',
        ts: '2026-07-21T00:00:00Z',
      },
    },
    {
      origin: 'cockpit',
      source: 'cockpit',
      turnId: 'g1',
      event: {
        type: 'assistant_text',
        agent: 'claude',
        text: 'FINDINGS\n```json\n[{"title":"X","body":"y"}]\n```',
        ts: '2026-07-21T00:00:01Z',
      },
    },
  ] as unknown as EventEnvelope[]
  const out = extractIssuesForRound(events, 'g1')
  assert.equal(out.issues.length, 1)
  assert.equal(out.issues[0].title, 'X')
})
