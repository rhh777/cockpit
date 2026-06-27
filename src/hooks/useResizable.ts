import { useCallback, useEffect, useRef, useState } from 'react'
import { PREFERENCES_CHANGED_EVENT } from '../lib/preferences'

/**
 * 可拖拽缩放面板宽度 hook。
 * @param storageKey localStorage 持久化 key
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
    const saved = localStorage.getItem(storageKey)
    if (saved) {
      const v = parseInt(saved, 10)
      if (Number.isFinite(v) && v >= minWidth && v <= maxWidth) return v
    }
    return defaultWidth
  })

  const widthRef = useRef(width)
  widthRef.current = width

  useEffect(() => {
    localStorage.setItem(storageKey, String(width))
  }, [storageKey, width])

  useEffect(() => {
    const onPrefs = () => {
      const saved = localStorage.getItem(storageKey)
      if (!saved) {
        setWidth(defaultWidth)
        return
      }
      const v = parseInt(saved, 10)
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
