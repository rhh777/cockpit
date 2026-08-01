import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { SettingsStore } from './settings-store'

test('missing settings use app defaults without claiming persistence', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-settings-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const store = new SettingsStore(path.join(dir, 'settings.json'))

  const result = await store.read()
  assert.equal(result.persisted, false)
  assert.equal(result.settings.cliByAgent.claude?.effort, 'medium')
  assert.equal(result.settings.cliByAgent.codex?.effort, 'medium')
})

test('settings persist all preferences and explicit CLI defaults across store instances', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-settings-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'settings.json')
  const store = new SettingsStore(file)

  await store.write({
    theme: 'dark',
    language: 'zh-CN',
    fontSize: 'large',
    defaultAgent: 'codex',
    enabledAgents: ['claude', 'codex'],
    defaultSourceFilter: 'codex',
    autoRefresh: false,
    cliByAgent: {
      claude: { model: 'claude-opus-4-8', effort: 'high' },
      codex: { model: 'gpt-5.5', effort: '' },
    },
    layout: { sidebarWidth: 312, reviewWidth: 480 },
  })

  const result = await new SettingsStore(file).read()
  assert.equal(result.persisted, true)
  assert.equal(result.settings.theme, 'dark')
  assert.equal(result.settings.language, 'zh-CN')
  assert.equal(result.settings.defaultAgent, 'codex')
  assert.deepEqual(result.settings.enabledAgents, ['claude', 'codex'])
  assert.deepEqual(result.settings.cliByAgent.codex, { model: 'gpt-5.5', effort: '' })
  assert.deepEqual(result.settings.layout, { sidebarWidth: 312, reviewWidth: 480 })
  assert.deepEqual(await store.cliDefaults('codex'), { model: 'gpt-5.5' })
})

test('invalid values are normalized and default agent stays enabled', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-settings-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const store = new SettingsStore(path.join(dir, 'settings.json'))

  const saved = await store.write({
    theme: 'neon',
    defaultAgent: 'codex',
    enabledAgents: ['claude', 'unknown'],
    layout: { sidebarWidth: -1 },
  })

  assert.equal(saved.theme, 'system')
  assert.equal(saved.defaultAgent, 'claude')
  assert.deepEqual(saved.enabledAgents, ['claude'])
  assert.deepEqual(saved.layout, {})
})
