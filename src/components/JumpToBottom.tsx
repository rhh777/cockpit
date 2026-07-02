import { Icon } from './Icon'

// 浮在 timeline 底部的「回到底部 / 新消息」胶囊。用户往上滚离底部时出现;
// 有新内容追加(hasNew)时高亮提示。点击滚回最末。
export function JumpToBottom({
  visible,
  hasNew,
  onClick,
}: {
  visible: boolean
  hasNew: boolean
  onClick: () => void
}) {
  if (!visible) return null
  return (
    <button
      className={`jump-to-bottom ${hasNew ? 'has-new' : ''}`}
      onClick={onClick}
      title={hasNew ? '有新消息,点击查看' : '回到底部'}
    >
      <Icon name="arrow-up" size={13} />
      {hasNew ? '新消息' : '回到底部'}
    </button>
  )
}
