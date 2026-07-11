import { useRef, useCallback } from 'react';

// Card-level up/down drag reorder, mirroring ClipNoteCard's row-reorder
// pointer pattern but operating on whole cards. `attr` is the data attribute
// that marks each card container (e.g. 'data-cell-id'); `onReorder(from,to)`
// commits a move. Returns a `startReorder(e, index)` to wire onto a drag
// handle's onPointerDown.
//
// This is intentionally separate from DragContext (the media→area drag
// channel): it reorders existing cards within one area and never arms
// beginDrag, so the two drag interactions stay isolated.
export function useCardReorder(
  attr: string,
  onReorder: (from: number, to: number) => void
) {
  const state = useRef<{ from: number } | null>(null);

  // The card index whose vertical box contains clientY. Cards are rendered in
  // document order, so querying the attribute yields them top-to-bottom.
  const indexAtPoint = useCallback(
    (clientY: number): number => {
      const nodes = Array.from(
        document.querySelectorAll(`[${attr}]`)
      ) as HTMLElement[];
      for (let i = 0; i < nodes.length; i += 1) {
        const r = nodes[i].getBoundingClientRect();
        if (clientY < r.top + r.height / 2) return i;
      }
      return nodes.length - 1;
    },
    [attr]
  );

  const startReorder = useCallback(
    (e: React.PointerEvent, index: number) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      state.current = { from: index };

      const move = (ev: PointerEvent) => {
        const st = state.current;
        if (!st) return;
        const to = indexAtPoint(ev.clientY);
        if (to === st.from || to < 0) return;
        onReorder(st.from, to);
        st.from = to;
      };
      const up = () => {
        state.current = null;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [indexAtPoint, onReorder]
  );

  return startReorder;
}
