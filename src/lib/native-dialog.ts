export async function pickLocalPaths(kind: 'file' | 'directory'): Promise<string[]> {
  try {
    const res = await fetch(`/api/native-dialog/open?kind=${kind}`, { method: 'POST' })
    if (res.ok) {
      const body = (await res.json()) as { paths?: string[] }
      return Array.isArray(body.paths) ? body.paths : []
    }
  } catch {
    /* fall through to Electron preload */
  }

  if (window.cockpitNative) {
    return kind === 'file' ? window.cockpitNative.pickFiles() : window.cockpitNative.pickDirectory()
  }
  throw new Error('native-picker-unavailable')
}
