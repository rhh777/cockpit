import { useCallback, useEffect, useRef, useState } from 'react'
import { PREFERENCES_CHANGED_EVENT, readLayoutPreference, setLayoutPreference } from '../lib/preferences'

/**
 * 可拖拽缩放面板宽度 hook。
 * @param storageKey 设置文件中的布局字段兼容 key
 * @param defaultWidth 默认宽度(px)
 * @param minWidth 最小宽度(px)
 * @param maxWidth 最大宽度(px)
 * @param direction 'left' = 左侧面板(拖右增大), 'right' = 右侧面板(拖左增大)
 */
export function useResizable(
  storageKey: string,
  defaultWidth: number,
  minWidth: number,
  maxWidth: number,
  direction: 'left' | 'right',
) {
  const [width, setWidth] = useState(() => {
    const saved = readLayoutPreference(storageKey)
    if (saved != null) {
      const v = saved
      if (Number.isFinite(v) && v >= minWidth && v <= maxWidth) return v
    }
    return defaultWidth
  })

  const widthRef = useRef(width)
  widthRef.current = width

  useEffect(() => {
    setLayoutPreference(storageKey, width)
  }, [storageKey, width])

  useEffect(() => {
    const onPrefs = () => {
      const saved = readLayoutPreference(storageKey)
      if (saved == null) {
        setWidth(defaultWidth)
        return
      }
      const v = saved
      if (Number.isFinite(v) && v >= minWidth && v <= maxWidth) setWidth(v)
    }
    window.addEventListener(PREFERENCES_CHANGED_EVENT, onPrefs)
    return () => window.removeEventListener(PREFERENCES_CHANGED_EVENT, onPrefs)
  }, [defaultWidth, maxWidth, minWidth, storageKey])

  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = widthRef.current

      const onMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX
        const next = direction === 'left' ? startWidth + delta : startWidth - delta
        const clamped = Math.max(minWidth, Math.min(maxWidth, next))
        setWidth(clamped)
      }

      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.body.classList.remove('resizing')
      }

      document.body.classList.add('resizing')
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [direction, minWidth, maxWidth],
  )

  return { width, setWidth, onDragStart }
}
