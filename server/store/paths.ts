import path from 'node:path'
import { COCKPIT_THREADS_ROOT } from '../config'
import type { Source } from '../loaders/types'

export function threadDir(source: Source, id: string): string {
  return path.join(COCKPIT_THREADS_ROOT, source, id)
}

export function followupsFile(source: Source, id: string): string {
  return path.join(threadDir(source, id), 'followups.jsonl')
}

export function threadAttachmentsDir(source: Source, id: string): string {
  return path.join(threadDir(source, id), 'attachments')
}

export function threadContextStateFile(source: Source, id: string): string {
  return path.join(threadDir(source, id), 'context-state.json')
}

export function threadSummaryFile(source: Source, id: string): string {
  return path.join(threadDir(source, id), 'summary.md')
}
