import { isPathWithinAllowedRoots, isValidSessionIdForSource, isValidSource } from '../util/security'
import { sessionRegistry } from '../registry/session-registry'

// 校验并 resolve 出已确认安全的 filePath(不变量 13)。返回 null = 应 404。
export async function resolveSafe(source: string, id: string): Promise<string | null> {
  if (!isValidSource(source) || !isValidSessionIdForSource(source, id)) return null
  const filePath = await sessionRegistry.resolve(source, id)
  if (!filePath) return null
  if (!isPathWithinAllowedRoots(filePath)) return null
  return filePath
}
