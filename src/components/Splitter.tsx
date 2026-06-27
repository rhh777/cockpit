/**
 * 可拖拽分隔条:放在两个面板之间,鼠标按住拖动改变面板宽度。
 * onDragStart 由 useResizable 提供。
 */
export function Splitter({
  side,
  onDragStart,
}: {
  side: 'left' | 'right'
  onDragStart: (e: React.MouseEvent) => void
}) {
  return (
    <div
      className={`splitter splitter-${side}`}
      onMouseDown={onDragStart}
    >
      <div className="splitter-handle" />
    </div>
  )
}
