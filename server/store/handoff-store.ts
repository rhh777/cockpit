import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { COCKPIT_HANDOFFS_ROOT } from '../config'
import type {
  BuiltContext,
  HandoffDetail,
  HandoffFreshness,
  HandoffManifest,
  HandoffSourceRef,
  HandoffSourceSnapshot,
  NativeLink,
} from '../handoffs/types'

const CANONICAL = {
  summary: 'summary.md',
  transcript: 'transcript.md',
  decisions: 'decisions.md',
  taskState: 'task_state.md',
  fileRefs: 'file_refs.md',
} as const

const ENTRIES = {
  codex: 'handoff.codex.md',
  claude: 'handoff.claude.md',
} as const

export function handoffDir(id: string): string {
  return path.join(COCKPIT_HANDOFFS_ROOT, id)
}

export function handoffManifestFile(id: string): string {
  return path.join(handoffDir(id), 'manifest.json')
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}

function sourceFromRef(ref: HandoffSourceRef): HandoffManifest['source'] {
  if (ref.kind === 'group-thread') {
    return { kind: 'group-thread', groupThreadId: ref.groupThreadId }
  }
  return { kind: ref.kind, source: ref.source, sessionId: ref.sessionId }
}

export const handoffStore = {
  async create(input: {
    sourceRef: HandoffSourceRef
    context: BuiltContext
  }): Promise<HandoffManifest> {
    const id = randomUUID()
    const dir = handoffDir(id)
    await fsp.mkdir(dir, { recursive: true })

    await Promise.all([
      fsp.writeFile(path.join(dir, CANONICAL.summary), input.context.canonical.summary, 'utf8'),
      fsp.writeFile(path.join(dir, CANONICAL.transcript), input.context.canonical.transcript, 'utf8'),
      fsp.writeFile(path.join(dir, CANONICAL.decisions), input.context.canonical.decisions, 'utf8'),
      fsp.writeFile(path.join(dir, CANONICAL.taskState), input.context.canonical.taskState, 'utf8'),
      fsp.writeFile(path.join(dir, CANONICAL.fileRefs), input.context.canonical.fileRefs, 'utf8'),
      fsp.writeFile(path.join(dir, ENTRIES.codex), input.context.entries.codex, 'utf8'),
      fsp.writeFile(path.join(dir, ENTRIES.claude), input.context.entries.claude, 'utf8'),
    ])

    const manifest: HandoffManifest = {
      handoffId: id,
      source: sourceFromRef(input.sourceRef),
      createdAt: new Date().toISOString(),
      cwd: input.context.cwd,
      title: input.context.title,
      snapshotMode: 'snapshot',
      sourceSnapshot: input.context.snapshot,
      files: {
        canonical: {
          summary: path.join(dir, CANONICAL.summary),
          transcript: path.join(dir, CANONICAL.transcript),
          decisions: path.join(dir, CANONICAL.decisions),
          taskState: path.join(dir, CANONICAL.taskState),
          fileRefs: path.join(dir, CANONICAL.fileRefs),
        },
        entries: {
          codex: path.join(dir, ENTRIES.codex),
          claude: path.join(dir, ENTRIES.claude),
        },
      },
      nativeLinks: [],
    }
    await fsp.writeFile(handoffManifestFile(id), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    return manifest
  },

  readManifest(id: string): Promise<HandoffManifest | null> {
    return readJson<HandoffManifest>(handoffManifestFile(id))
  },

  async detail(id: string, currentSnapshot: HandoffSourceSnapshot | null): Promise<HandoffDetail | null> {
    const manifest = await this.readManifest(id)
    if (!manifest) return null
    return { ...manifest, freshness: computeFreshness(manifest.sourceSnapshot, currentSnapshot) }
  },

  async appendNativeLink(id: string, link: NativeLink): Promise<HandoffManifest | null> {
    const manifest = await this.readManifest(id)
    if (!manifest) return null
    const next: HandoffManifest = { ...manifest, nativeLinks: [...manifest.nativeLinks, link] }
    await fsp.writeFile(handoffManifestFile(id), JSON.stringify(next, null, 2) + '\n', 'utf8')
    return next
  },
}

export function computeFreshness(
  snapshot: HandoffSourceSnapshot,
  current: HandoffSourceSnapshot | null,
): HandoffFreshness {
  if (!current) return { status: 'unknown', reason: 'source not resolvable' }

  const updatedDrift =
    snapshot.sourceUpdatedAt &&
    current.sourceUpdatedAt &&
    current.sourceUpdatedAt > snapshot.sourceUpdatedAt
  const mtimeDrift =
    snapshot.fileMtimeMs != null &&
    current.fileMtimeMs != null &&
    current.fileMtimeMs > snapshot.fileMtimeMs
  const countDrift =
    snapshot.sourceEventCount != null &&
    current.sourceEventCount != null &&
    current.sourceEventCount > snapshot.sourceEventCount
  const revDrift =
    snapshot.summaryRevision != null &&
    current.summaryRevision != null &&
    current.summaryRevision > snapshot.summaryRevision

  if (updatedDrift || mtimeDrift || countDrift || revDrift) {
    return {
      status: 'stale',
      staleSince: current.sourceUpdatedAt ?? undefined,
      reason: updatedDrift
        ? 'source updatedAt advanced'
        : mtimeDrift
          ? 'file mtime advanced'
          : countDrift
            ? 'event count advanced'
            : 'summary revision advanced',
    }
  }
  return { status: 'fresh' }
}
