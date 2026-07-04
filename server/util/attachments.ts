import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ChatAttachment } from '../loaders/types'

// 前端草稿:file/directory 只带路径,imageData 带 base64。规范化后统一成 ChatAttachment,
// 图片落到指定 attachments 目录(群聊用 group-threads/<id>/attachments,单会话用
// threads/<source>/<id>/attachments)。不复制 file/directory,只校验存在性。
export type AttachmentDraft =
  | { kind: 'file'; path?: string; name?: string }
  | { kind: 'directory'; path?: string; name?: string }
  | { kind: 'imageData'; dataUrl?: string; name?: string; mimeType?: string }

const IMAGE_MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

function attachmentName(filePath: string, fallback = 'attachment'): string {
  return path.basename(filePath) || fallback
}

/** 把附件路径渲染成可注入 prompt 的引用行(CLI 凭路径自行读取)。 */
export function renderAttachmentLines(attachments?: ChatAttachment[]): string[] {
  if (!attachments?.length) return []
  return [
    '[Attachments]',
    ...attachments.map((a) => {
      const label = a.kind === 'directory' ? 'directory' : a.kind === 'image' ? `image ${a.mimeType}` : 'file'
      const target = a.kind === 'image' ? a.path ?? '[embedded image]' : a.path
      return `- ${label}: ${a.name} -> ${target}`
    }),
  ]
}

export async function normalizeAttachments(
  attachmentsDir: string,
  drafts: AttachmentDraft[] | undefined,
): Promise<ChatAttachment[]> {
  if (!Array.isArray(drafts) || drafts.length === 0) return []
  const out: ChatAttachment[] = []
  for (const draft of drafts.slice(0, 12)) {
    if (draft?.kind === 'file' || draft?.kind === 'directory') {
      if (typeof draft.path !== 'string' || !draft.path.trim()) continue
      const resolved = path.resolve(draft.path)
      let st
      try {
        st = await fs.stat(resolved)
      } catch {
        continue
      }
      if (draft.kind === 'file' && !st.isFile()) continue
      if (draft.kind === 'directory' && !st.isDirectory()) continue
      out.push({
        kind: draft.kind,
        path: resolved,
        name: typeof draft.name === 'string' && draft.name.trim() ? draft.name.trim() : attachmentName(resolved),
      })
    } else if (draft?.kind === 'imageData') {
      const mimeType = typeof draft.mimeType === 'string' ? draft.mimeType : ''
      const ext = IMAGE_MIME_EXT[mimeType]
      const dataUrl = typeof draft.dataUrl === 'string' ? draft.dataUrl : ''
      const marker = `data:${mimeType};base64,`
      if (!ext || !dataUrl.startsWith(marker)) continue
      const bytes = Buffer.from(dataUrl.slice(marker.length), 'base64')
      if (bytes.length === 0 || bytes.length > 20 * 1024 * 1024) continue
      await fs.mkdir(attachmentsDir, { recursive: true })
      const safeName = (draft.name?.trim() || `screenshot-${Date.now()}${ext}`).replace(/[^\w.\- ]+/g, '_')
      const filePath = path.join(attachmentsDir, `${randomUUID()}-${safeName.endsWith(ext) ? safeName : `${safeName}${ext}`}`)
      await fs.writeFile(filePath, bytes)
      out.push({ kind: 'image', path: filePath, name: path.basename(filePath), mimeType })
    }
  }
  return out
}
