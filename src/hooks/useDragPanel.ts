// ============================================================
// ToubkalCAD – useDragPanel.ts
//
// Tiny dependency-free drag helper for floating panels.
// react-draggable does not work reliably here (its transform is an
// offset from the element's flow position, which with position:fixed
// /createPortal lands off-screen). This hook drives explicit top/left.
//
// Usage:
//   const { pos, onHandleMouseDown } = useDragPanel(x0, y0);
//   <div style={{ position:'fixed', top: pos.y, left: pos.x }}>
//     <div onMouseDown={onHandleMouseDown} style={{ cursor:'move' }}>…header…</div>
//   </div>
// ============================================================

import { useCallback, useRef, useState } from 'react';

export function useDragPanel(initialX: number, initialY: number) {
  const [pos, setPos] = useState({ x: initialX, y: initialY });
  const offset = useRef<{ dx: number; dy: number } | null>(null);

  const onHandleMouseDown = useCallback((e: React.MouseEvent) => {
    // Ignore drags that start on an interactive control inside the header
    const tgt = e.target as HTMLElement;
    if (tgt.closest('button, input, select, textarea')) return;
    e.preventDefault();

    offset.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };

    const onMove = (ev: MouseEvent) => {
      if (!offset.current) return;
      const x = ev.clientX - offset.current.dx;
      const y = ev.clientY - offset.current.dy;
      // Keep at least a sliver on-screen so the panel can't be lost
      const clampedX = Math.max(-200, Math.min(window.innerWidth  - 60, x));
      const clampedY = Math.max(0,    Math.min(window.innerHeight - 40, y));
      setPos({ x: clampedX, y: clampedY });
    };
    const onUp = () => {
      offset.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [pos.x, pos.y]);

  return { pos, setPos, onHandleMouseDown };
}
