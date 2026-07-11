import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import { groupThreadDir, groupThreadStore } from './group-thread-store'

const createdIds = new Set<string>()

after(async () => {
  await Promise.all([...createdIds].map((id) => fsp.rm(groupThreadDir(id), { recursive: true, force: true })))
})

test('discover reports group agents from transcript activity, not default members', async () => {
  const state = await groupThreadStore.create()
  createdIds.add(state.id)

  const emptySummary = (await groupThreadStore.discover()).find((s) => s.id === state.id)
  assert.ok(emptySummary)
  assert.deepEqual(emptySummary.extensions?.agents, [])

  await groupThreadStore.appendEvent(state.id, {
    origin: 'cockpit',
    source: 'cockpit',
    sourceEventId: 'u1',
    turnId: 'turn_1',
    event: {
      type: 'user_text',
      text: '@opencode please check this',
      ts: '2026-07-11T00:00:00.000Z',
      targetAgents: ['opencode'],
      mentions: ['opencode'],
    },
  })
  await groupThreadStore.appendEvent(state.id, {
    origin: 'cockpit',
    source: 'cockpit',
    sourceEventId: 'a1',
    turnId: 'turn_1',
    runId: 'run_1',
    event: {
      type: 'assistant_text',
      text: 'ok',
      ts: '2026-07-11T00:00:01.000Z',
      agent: 'opencode',
    },
  })

  const activeSummary = (await groupThreadStore.discover()).find((s) => s.id === state.id)
  assert.ok(activeSummary)
  assert.deepEqual(activeSummary.extensions?.agents, ['opencode'])
})
