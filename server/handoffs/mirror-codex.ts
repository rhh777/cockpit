// docs/07 Phase 4:Codex thread 单次镜像抓取(exploration 阶段,不做长驻同步)。
//
// - 输入:一个 codex nativeLink 上的 nativeThreadId
// - 动作:spawn `codex app-server`,发 `thread/read includeTurns=true`,把返回的 items
//   序列化落到 `~/.cockpit/handoffs/<id>/mirror.<linkId>.md`
// - 成功 -> 把 nativeLink.linkLevel 升级到 'mirrored',记录 mirroredAt
// - 失败 -> nativeLink 回退到 'linked'(如果之前是 mirrored),不动 status
//
// 显式限制(和 docs/07 §Phase 4 非目标):
// - Cockpit group thread 仍是群聊事实源;这里只是本地快照,不反向覆盖 handoff bundle。
// - 不做增量 diff;每次都是全量重写,简单可回滚。

import fsp from 'node:fs/promises'
import path from 'node:path'
import { CodexAppServer } from '../adapters/codex-app-server'
import { handoffDir, handoffStore } from '../store/handoff-store'
import type { HandoffManifest, NativeLink } from './types'

export interface MirrorResult {
  ok: boolean
  linkLevel: NativeLink['linkLevel']
  mirrorFile?: string
  error?: string
  itemCount?: number
}

export async function mirrorCodexThread(handoffId: string, linkId: string): Promise<MirrorResult> {
  const manifest = await handoffStore.readManifest(handoffId)
  if (!manifest) return { ok: false, linkLevel: 'none', error: 'handoff not found' }
  const link = manifest.nativeLinks.find((l) => l.id === linkId)
  if (!link) return { ok: false, linkLevel: 'none', error: 'native link not found' }
  if (link.provider !== 'codex' || !link.nativeThreadId) {
    return { ok: false, linkLevel: link.linkLevel, error: 'not a codex linked thread' }
  }

  const server = new CodexAppServer()
  try {
    await server.spawn()
    const loopP = server.readLoop().catch(() => {})
    await server.request('initialize', {
      clientInfo: { name: 'cockpit', title: 'Cockpit', version: '0.0.1' },
      capabilities: null,
    })
    const res = (await server.request('thread/read', {
      threadId: link.nativeThreadId,
      includeTurns: true,
    })) as { thread?: { turns?: Array<{ items?: unknown[] }> } }

    const turns = res.thread?.turns ?? []
    const items = turns.flatMap((t) => t.items ?? [])
    const md = renderMirror(manifest, link, turns.length, items)
    const dir = handoffDir(handoffId)
    await fsp.mkdir(dir, { recursive: true })
    const mirrorFile = path.join(dir, `mirror.${linkId}.md`)
    await fsp.writeFile(mirrorFile, md, 'utf8')

    await handoffStore.updateNativeLink(handoffId, linkId, {
      linkLevel: 'mirrored',
      status: 'created',
    })
    server.kill()
    await loopP
    return { ok: true, linkLevel: 'mirrored', mirrorFile, itemCount: items.length }
  } catch (e) {
    server.kill()
    // 从 mirrored 降回 linked;从 linked/none 不动
    if (link.linkLevel === 'mirrored') {
      await handoffStore.updateNativeLink(handoffId, linkId, { linkLevel: 'linked' })
    }
    return { ok: false, linkLevel: link.linkLevel === 'mirrored' ? 'linked' : link.linkLevel, error: String((e as Error)?.message ?? e) }
  }
}

function renderMirror(manifest: HandoffManifest, link: NativeLink, turnCount: number, items: any[]): string {
  const lines: string[] = [
    `# Codex Thread Mirror`,
    '',
    `- handoff: \`${manifest.handoffId}\``,
    `- native link: \`${link.id}\``,
    `- thread: \`${link.nativeThreadId}\``,
    `- captured at: ${new Date().toISOString()}`,
    `- turns: ${turnCount}`,
    `- items: ${items.length}`,
    '',
    '## Items',
    '',
  ]
  for (const item of items) {
    const t = item?.type ?? 'unknown'
    if (t === 'userMessage') {
      const parts = Array.isArray(item.content) ? item.content : []
      const text = parts
        .map((p: any) => (p?.type === 'text' ? p.text : ''))
        .filter(Boolean)
        .join('\n')
      lines.push(`### User`, '', text || '_(empty)_', '')
    } else if (t === 'agentMessage') {
      lines.push(`### Assistant`, '', String(item.text ?? ''), '')
    } else if (t === 'commandExecution') {
      lines.push(
        `### shell (${item.status})`,
        '',
        '```',
        String(item.command ?? ''),
        '```',
        '',
        '```',
        String(item.aggregatedOutput ?? '').slice(0, 4000),
        '```',
        '',
      )
    } else if (t === 'reasoning') {
      const text = Array.isArray(item.content) ? item.content.join('\n') : String(item.content ?? '')
      lines.push(`### Thinking`, '', text, '')
    } else {
      lines.push(`### ${t}`, '', '```json', JSON.stringify(item, null, 2).slice(0, 2000), '```', '')
    }
  }
  return lines.join('\n')
}
