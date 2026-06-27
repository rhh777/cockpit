import type { SessionSourceLoader, SessionSummary } from './types'
import { groupThreadStore } from '../store/group-thread-store'

export const cockpitLoader: SessionSourceLoader = {
  source: 'cockpit',

  async discover() {
    return { summaries: await groupThreadStore.discover(), warnings: [] }
  },

  async loadEvents(filePath: string) {
    const id = filePath.split('/').at(-2) ?? ''
    const state = await groupThreadStore.readState(id)
    const events = await groupThreadStore.readTranscript(id)
    const summaryPatch: Partial<SessionSummary> = state
      ? {
          id,
          source: 'cockpit',
          title: state.title,
          cwd: state.cwd,
          startedAt: state.startedAt,
          updatedAt: state.updatedAt,
          messageCount: events.length,
          extensions: { kind: 'group-chat', agents: state.agents },
        }
      : {}
    return { summaryPatch, events, warnings: [] }
  },
}
