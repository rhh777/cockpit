import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loaderBySource } from './loaders'
import type { SessionSourceLoader } from './loaders/types'
import { loadSessionDetail } from './sessions-service'

test('OpenCode native cache invalidates when SQLite WAL sidecar changes', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cockpit-opencode-cache-'))
  const db = path.join(dir, 'opencode.db')
  const id = `ses_${randomUUID().replaceAll('-', '')}`
  const original = loaderBySource.get('opencode')
  let loads = 0

  const fakeLoader: SessionSourceLoader = {
    source: 'opencode',
    async discover() {
      return { summaries: [], warnings: [] }
    },
    async loadEvents(filePath: string) {
      loads += 1
      const base = await fsp.readFile(filePath, 'utf8')
      const wal = await fsp.readFile(`${filePath}-wal`, 'utf8').catch(() => '')
      return {
        summaryPatch: {},
        warnings: [],
        events: [
          {
            origin: 'native',
            source: 'opencode',
            sourceEventId: `load:${loads}`,
            event: {
              type: 'assistant_text',
              text: `${base}${wal}`,
              ts: '2026-07-13T00:00:00.000Z',
              agent: 'opencode',
            },
          },
        ],
      }
    },
  }

  try {
    await fsp.writeFile(db, 'base')
    loaderBySource.set('opencode', fakeLoader)

    const first = await loadSessionDetail('opencode', id, db)
    assert.equal(first?.events[0]?.event.type, 'assistant_text')
    assert.equal(first?.events[0]?.event.type === 'assistant_text' ? first.events[0].event.text : '', 'base')

    await fsp.writeFile(`${db}-wal`, '+wal')
    const second = await loadSessionDetail('opencode', id, db)

    assert.equal(loads, 2)
    assert.equal(second?.events[0]?.event.type, 'assistant_text')
    assert.equal(second?.events[0]?.event.type === 'assistant_text' ? second.events[0].event.text : '', 'base+wal')
  } finally {
    if (original) loaderBySource.set('opencode', original)
    else loaderBySource.delete('opencode')
    await fsp.rm(dir, { recursive: true, force: true })
  }
})
