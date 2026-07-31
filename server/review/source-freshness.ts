// Review Room source snapshot 的新鲜度检测(docs/14 §上下文来源)。
//
// 「source snapshot 默认是一次性快照。后续源文件变化时,旧 Review Room 标记 stale 或显示
// 『source changed』,不要静默改写历史。」—— 所以这里只**判断并展示**,永远不回写 snapshot。
//
// 判定保守:snapshot 里没有可比字段时返回 unknown 而不是 stale,避免老房间(创建时还没记
// 这些字段)全部被误报成已变更。

import fsp from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ReviewRoomSource } from '../store/review-room-store'

const execFileAsync = promisify(execFile)

export interface ReviewSourceFreshness {
  status: 'fresh' | 'stale' | 'unknown' | 'missing'
  /** 面向机器的原因码,UI 负责翻译成文案。 */
  reason?:
    | 'freeform'
    | 'no-baseline'
    | 'git-head-changed'
    | 'file-modified'
    | 'file-missing'
    | 'session-grew'
    | 'session-modified'
    | 'transcript-grew'
    | 'summary-updated'
    | 'source-missing'
    | 'not-resolvable'
  /** 变化的具体对象(路径 / session id),给 UI 做 title 提示。 */
  detail?: string
}

export interface FreshnessProbe {
  /** 读 git HEAD;失败(非 git 仓库 / git 不可用)返回 undefined。 */
  gitHead(cwd: string): Promise<string | undefined>
  /** 读文件 mtime;不存在返回 null。 */
  fileMtimeMs(path: string): Promise<number | null>
  /** 目录是否存在。 */
  dirExists(path: string): Promise<boolean>
  /** 原生 session:返回 {eventCount, fileMtimeMs};找不到返回 null。 */
  nativeSession(source: string, sessionId: string): Promise<{ fileMtimeMs?: number; eventCount?: number } | null>
  /** 群聊:返回 {eventCount, summaryRevision};找不到返回 null。 */
  groupThread(id: string): Promise<{ eventCount: number; summaryRevision?: number } | null>
}

export async function computeSourceFreshness(
  source: ReviewRoomSource,
  probe: FreshnessProbe,
): Promise<ReviewSourceFreshness> {
  const snap = source.sourceSnapshot

  if (source.kind === 'freeform') {
    // 自由文本没有外部来源,快照即内容,永远不会「变化」。
    return { status: 'fresh', reason: 'freeform' }
  }

  if (source.kind === 'repository' || source.kind === 'directory') {
    const dir = source.paths?.[0]?.path ?? source.cwd
    if (!dir) return { status: 'unknown', reason: 'not-resolvable' }
    if (!(await probe.dirExists(dir))) return { status: 'missing', reason: 'source-missing', detail: dir }
    if (!snap?.gitHead) return { status: 'unknown', reason: 'no-baseline', detail: dir }
    const head = await probe.gitHead(dir)
    if (!head) return { status: 'unknown', reason: 'not-resolvable', detail: dir }
    return head === snap.gitHead
      ? { status: 'fresh' }
      : { status: 'stale', reason: 'git-head-changed', detail: dir }
  }

  if (source.kind === 'files' || source.kind === 'document') {
    const baseline = snap?.pathMtimes
    if (!baseline?.length) return { status: 'unknown', reason: 'no-baseline' }
    for (const entry of baseline) {
      const now = await probe.fileMtimeMs(entry.path)
      if (now === null) return { status: 'missing', reason: 'file-missing', detail: entry.path }
      if (now > entry.mtimeMs) return { status: 'stale', reason: 'file-modified', detail: entry.path }
    }
    return { status: 'fresh' }
  }

  if (source.kind === 'native-session' || source.kind === 'cockpit-followup') {
    const ref = source.nativeSession
    if (!ref) return { status: 'unknown', reason: 'not-resolvable' }
    const current = await probe.nativeSession(ref.source, ref.sessionId)
    if (!current) return { status: 'missing', reason: 'source-missing', detail: ref.sessionId }
    if (snap?.eventCount == null && snap?.fileMtimeMs == null) {
      return { status: 'unknown', reason: 'no-baseline', detail: ref.sessionId }
    }
    if (snap.eventCount != null && current.eventCount != null && current.eventCount > snap.eventCount) {
      return { status: 'stale', reason: 'session-grew', detail: ref.sessionId }
    }
    if (snap.fileMtimeMs != null && current.fileMtimeMs != null && current.fileMtimeMs > snap.fileMtimeMs) {
      return { status: 'stale', reason: 'session-modified', detail: ref.sessionId }
    }
    return { status: 'fresh' }
  }

  if (source.kind === 'group-thread') {
    const id = source.groupThreadId
    if (!id) return { status: 'unknown', reason: 'not-resolvable' }
    const current = await probe.groupThread(id)
    if (!current) return { status: 'missing', reason: 'source-missing', detail: id }
    if (snap?.eventCount == null && snap?.summaryRevision == null) {
      return { status: 'unknown', reason: 'no-baseline', detail: id }
    }
    if (snap.eventCount != null && current.eventCount > snap.eventCount) {
      return { status: 'stale', reason: 'transcript-grew', detail: id }
    }
    if (
      snap.summaryRevision != null &&
      current.summaryRevision != null &&
      current.summaryRevision > snap.summaryRevision
    ) {
      return { status: 'stale', reason: 'summary-updated', detail: id }
    }
    return { status: 'fresh' }
  }

  return { status: 'unknown', reason: 'not-resolvable' }
}

/** 生产环境用的真实 probe。所有读取都 best-effort,失败降级为「读不到」而不是抛。 */
export function makeFreshnessProbe(deps: {
  resolveNativeSession: (source: string, sessionId: string) => Promise<string | null>
  readGroupThread: (id: string) => Promise<{ eventCount: number; summaryRevision?: number } | null>
}): FreshnessProbe {
  return {
    async gitHead(cwd) {
      try {
        const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { timeout: 2000 })
        return stdout.trim() || undefined
      } catch {
        return undefined
      }
    },
    async fileMtimeMs(path) {
      const st = await fsp.stat(path).catch(() => null)
      return st ? st.mtimeMs : null
    },
    async dirExists(path) {
      const st = await fsp.stat(path).catch(() => null)
      return !!st?.isDirectory()
    },
    async nativeSession(source, sessionId) {
      const filePath = await deps.resolveNativeSession(source, sessionId).catch(() => null)
      if (!filePath) return null
      const st = await fsp.stat(filePath).catch(() => null)
      if (!st) return null
      // 只 stat 不解析:mtime 足以判断「有没有再写过」,避免 GET 时全量重解析大 session。
      return { fileMtimeMs: st.mtimeMs }
    },
    async groupThread(id) {
      return deps.readGroupThread(id).catch(() => null)
    },
  }
}
