import { useRef, useCallback, useEffect } from 'react';
import { Plus } from 'lucide-react';
import { useDrag, type DragPayload, type DragItem } from '../../context/DragContext';
import type { GenImageItem } from '../../context/GenImagesContext';
import { useGenStore } from '../../context/GenStoreContext';
import GenCell from './GenCell';
import { useCardReorder } from './useCardReorder';

// Container for the gen area (生图区). The cell/slot state lives in GenStore so
// it can be persisted per project and stay in sync with material renames.
// Drop routing: onto a cell -> append to that cell; onto blank frame -> new cell.
export default function GenArea() {
  const {
    cells,
    addImageToCell,
    newCellWithImage,
    newEmptyCell,
    reorderInCell,
    reorderCells,
    deleteImage,
    deleteCell,
  } = useGenStore();
  const { dragPayload, pointer, subscribeDrop } = useDrag();
  const panelRef = useRef<HTMLDivElement>(null);
  const startCardReorder = useCardReorder('data-cell-id', reorderCells);

  // Live drop-target highlight (recomputed from the pointer each render).
  const insidePanel = (() => {
    if (!dragPayload) return false;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return false;
    const { x, y } = pointer;
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  })();

  const cellIdAtPoint = (x: number, y: number): string => {
    const el = document.elementFromPoint(x, y);
    const cellEl = el?.closest('[data-cell-id]') as HTMLElement | null;
    return cellEl?.dataset.cellId ?? '';
  };

  const dropTarget = dragPayload && insidePanel ? cellIdAtPoint(pointer.x, pointer.y) : '';
  const frameOver = !!dragPayload && insidePanel;

  const dragItemToItem = useCallback((d: DragItem): GenImageItem => ({
    id: `slot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    mediaId: d.mediaId,
    name: d.name,
    thumb: d.thumb || '',
    path: d.path || '',
    meta: d.meta || '',
    type: d.type,
  }), []);
  // Every media in the drag (multi-selection → items; single → the payload).
  const payloadToItems = useCallback((payload: DragPayload): GenImageItem[] => {
    const src = payload.items && payload.items.length > 0 ? payload.items : [payload];
    return src.map(dragItemToItem);
  }, [dragItemToItem]);

  // Route the drop: onto a cell -> append; onto blank frame -> new cell.
  useEffect(() => {
    const unsub = subscribeDrop((payload, x, y) => {
      const rect = panelRef.current?.getBoundingClientRect();
      if (!rect) return;
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
      const items = payloadToItems(payload);
      if (items.length === 0) return;
      const targetId = cellIdAtPoint(x, y);
      if (targetId) {
        items.forEach((it) => addImageToCell(targetId, it));
      } else {
        // First image seeds a new cell; the rest append into it.
        const [first, ...rest] = items;
        const newId = newCellWithImage(first);
        rest.forEach((it) => addImageToCell(newId, it));
      }
    });
    return unsub;
  }, [subscribeDrop, payloadToItems, addImageToCell, newCellWithImage]);

  return (
    <div
      ref={panelRef}
      className={`scrollbar-dark flex flex-col h-full w-full min-w-0 rounded-sm overflow-y-auto overflow-x-hidden p-2 gap-2 transition-colors duration-200 ${
        frameOver && !dropTarget ? 'bg-[#2EC4B6]/5' : 'bg-[#2A2A2A]'
      }`}
    >
      {/* B5: manual "new empty cell" — start a gen block by typing, no drag. */}
      <div className="shrink-0 flex items-center justify-end">
        <button
          onClick={newEmptyCell}
          title="新建一个空白生图块"
          className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-[#8A8A8A] hover:text-[#2EC4B6] hover:bg-[#333333] transition-colors cursor-pointer"
        >
          <Plus size={12} />
          <span>新建空白 cell</span>
        </button>
      </div>
      {cells.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-[#555555] text-[13px] select-none">
          拖动素材到此处创建生图块
        </div>
      ) : (
        <>
          {cells.map((cell) => (
            <div key={cell.id} data-cell-id={cell.id} className="min-w-0">
              <GenCell
                cellId={cell.id}
                images={cell.images}
                note={cell.note}
                dragOver={dropTarget === cell.id}
                onReorder={(from, to) => reorderInCell(cell.id, from, to)}
                onDeleteImage={(slotId) => deleteImage(cell.id, slotId)}
                onDeleteCell={() => deleteCell(cell.id)}
                onHandlePointerDown={(e) =>
                  startCardReorder(e, cells.findIndex((c) => c.id === cell.id))
                }
              />
            </div>
          ))}
          {/* Always-present drop zone so a new cell can be created even when the
              existing cells fill (and overflow) the panel — there is nowhere
              else blank to drop onto once the list is long. Not a data-cell-id
              element, so a drop here routes to newCellWithImage. */}
          <div
            className={`shrink-0 min-h-[96px] flex items-center justify-center rounded-sm border border-dashed text-[12px] select-none transition-colors ${
              frameOver && !dropTarget
                ? 'border-[#2EC4B6] text-[#2EC4B6] bg-[#2EC4B6]/5'
                : 'border-[#3D3D3D] text-[#555555]'
            }`}
          >
            拖动素材到此处新建生图块
          </div>
        </>
      )}
    </div>
  );
}
