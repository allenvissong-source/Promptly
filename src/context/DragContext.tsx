import { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import type { ReactNode } from 'react';

export type DragClipType = 'video' | 'image' | 'audio';

export interface DragItem {
  mediaId: number;
  name: string;
  thumb: string;
  path: string;
  meta: string;
  type: DragClipType;
}

export interface DragPayload extends DragItem {
  // When a multi-selection is dragged, `items` carries every selected media
  // (the primary included). Single drags leave it undefined, so existing
  // single-payload consumers keep working unchanged.
  items?: DragItem[];
}

type DropHandler = (payload: DragPayload, x: number, y: number) => void;

interface DragContextValue {
  dragPayload: DragPayload | null;
  pointer: { x: number; y: number };
  beginDrag: (payload: DragPayload, x: number, y: number) => void;
  subscribeDrop: (handler: DropHandler) => () => void;
}

const DragContext = createContext<DragContextValue | null>(null);

export function useDrag() {
  const ctx = useContext(DragContext);
  if (!ctx) throw new Error('useDrag must be used within DragProvider');
  return ctx;
}

// Pointer-based internal drag (media card -> gen area).
// HTML5 DnD is intercepted by Tauri's native drag-drop on Windows, so the
// webview-internal drag channel is implemented on pointer events instead,
// leaving the native onDragDropEvent free for OS file-import drops.
export function DragProvider({ children }: { children: ReactNode }) {
  const [dragPayload, setDragPayload] = useState<DragPayload | null>(null);
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  const dropHandlers = useRef<Set<DropHandler>>(new Set());
  const pending = useRef<{ payload: DragPayload; x: number; y: number } | null>(null);

  const beginDrag = useCallback((payload: DragPayload, x: number, y: number) => {
    // Arm a pending drag; it only activates once the pointer moves past a
    // small threshold, so a plain click never flashes the drag ghost.
    pending.current = { payload, x, y };
    setPointer({ x, y });
  }, []);

  const subscribeDrop = useCallback((handler: DropHandler) => {
    dropHandlers.current.add(handler);
    return () => {
      dropHandlers.current.delete(handler);
    };
  }, []);

  // Arm phase: watch for threshold movement or release before a drag activates.
  useEffect(() => {
    if (dragPayload) return;
    const move = (e: PointerEvent) => {
      const p = pending.current;
      if (!p) return;
      if (Math.abs(e.clientX - p.x) > 5 || Math.abs(e.clientY - p.y) > 5) {
        setPointer({ x: e.clientX, y: e.clientY });
        setDragPayload(p.payload);
      }
    };
    const up = () => {
      pending.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [dragPayload]);

  useEffect(() => {
    if (!dragPayload) return;
    const move = (e: PointerEvent) => setPointer({ x: e.clientX, y: e.clientY });
    const up = (e: PointerEvent) => {
      dropHandlers.current.forEach((h) => h(dragPayload, e.clientX, e.clientY));
      pending.current = null;
      setDragPayload(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [dragPayload]);

  return (
    <DragContext.Provider value={{ dragPayload, pointer, beginDrag, subscribeDrop }}>
      {children}
      {dragPayload && (
        <div
          className="pointer-events-none fixed z-[9999] flex items-center gap-2 rounded-md border border-[#2EC4B6] bg-[#252525]/95 px-2 py-1.5 shadow-lg"
          style={{ left: pointer.x + 12, top: pointer.y + 12 }}
        >
          {dragPayload.thumb ? (
            <img src={dragPayload.thumb} alt="" className="w-8 h-8 rounded object-cover" />
          ) : null}
          <span className="max-w-[160px] truncate text-[12px] text-[#E5E5E5]">{dragPayload.name}</span>
          {dragPayload.items && dragPayload.items.length > 1 && (
            <span className="ml-0.5 shrink-0 rounded-full bg-[#2EC4B6] px-1.5 py-0.5 text-[10px] font-medium leading-none text-white">
              {dragPayload.items.length}
            </span>
          )}
        </div>
      )}
    </DragContext.Provider>
  );
}
