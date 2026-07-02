import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

// 让任意可滚动容器"粘"在底部:实时追加内容时,若用户停在底部附近就自动跟随滚到底;
// 否则不打断阅读,只把 hasNew 置 true(供上层浮出「新消息」按钮)。
// EventTimeline(虚拟化)与 NarrativeTimeline(普通列表)共用同一套跟随逻辑,
// 差异只在具体的 scrollToEnd 实现(虚拟列表用 scrollToIndex,普通列表用 scrollTop)。
//
// scrollRef:可滚动容器的 ref,由调用方创建(虚拟化列表需要提前把它交给 virtualizer)。
// count:任何随新内容单调增长的计数(通常传 events.length),用作"是否有新内容"的信号。
// scrollToEnd:把容器滚到最末的具体动作,由调用方按自己的容器实现。
export function useStickToBottom(
  scrollRef: RefObject<HTMLElement | null>,
  count: number,
  scrollToEnd: () => void,
) {
  const [atBottom, setAtBottom] = useState(true)
  const [hasNew, setHasNew] = useState(false)

  const isNearBottom = useCallback(() => {
    const el = scrollRef.current
    // el 尚未挂载时按"不在底部"处理,避免把用户强拉到底(叙事视图默认从顶部读)。
    return el ? el.scrollHeight - el.scrollTop - el.clientHeight < 120 : false
  }, [scrollRef])

  const onScroll = useCallback(() => {
    const near = isNearBottom()
    setAtBottom(near)
    if (near) setHasNew(false)
  }, [isNearBottom])

  const jumpToBottom = useCallback(() => {
    scrollToEnd()
    setHasNew(false)
  }, [scrollToEnd])

  // 增长时实时量一次真实位置再决定跟随/提示,不依赖可能过期的缓存状态。
  const lastCount = useRef(count)
  useEffect(() => {
    if (count > lastCount.current) {
      if (isNearBottom()) scrollToEnd()
      else setHasNew(true)
    }
    lastCount.current = count
  }, [count, scrollToEnd, isNearBottom])

  return { atBottom, hasNew, onScroll, jumpToBottom }
}
