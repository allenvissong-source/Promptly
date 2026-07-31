import {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
  type ReactNode,
} from 'react';
import type { JSONContent } from '@tiptap/react';
import type { GenImageItem } from './GenImagesContext';
import { useProject } from './ProjectContext';
import { useHistory } from './HistoryContext';
import { loadGenCells, saveGenCells } from '../lib/db';

// A 小格子 (cell): an independent group with its own ordered image list and its
// own note (Tiptap JSON). Ordinals (Image1/2/3) restart at 1 inside each cell.
export interface GenCellData {
  id: string;
  images: GenImageItem[];
  note: JSONContent | null;
}

interface GenStoreValue {
  cells: GenCellData[];
  // Manual save: true when there are unsaved changes since the last save/load.
  dirty: boolean;
  save: () => Promise<void>;
  addImageToCell: (cellId: string, item: GenImageItem) => void;
  // Create a new cell seeded with one image (drag onto blank area). Returns the
  // new cell id so a multi-image drop can append the rest into the same cell.
  newCellWithImage: (item: GenImageItem) => string;
  // B5: manually append an empty cell (no images, empty note) so the user can
  // start a gen block by typing rather than dragging a material in.
  newEmptyCell: () => void;
  reorderInCell: (cellId: string, from: number, to: number) => void;
  // Reorder the cells themselves (card-level up/down drag).
  reorderCells: (from: number, to: number) => void;
  deleteImage: (cellId: string, slotId: string) => void;
  deleteCell: (cellId: string) => void;
  setNote: (cellId: string, note: JSONContent) => void;
  // Called when a material is renamed in the media library, so every slot that
  // references it (and thus every @ chip skinned by name) updates live.
  renameMedia: (mediaId: number, name: string) => void;
}

const GenStoreContext = createContext<GenStoreValue | null>(null);

export function useGenStore(): GenStoreValue {
  const ctx = useContext(GenStoreContext);
  if (!ctx) throw new Error('useGenStore must be used within GenStoreProvider');
  return ctx;
}

const rid = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

export function GenStoreProvider({ children }: { children: ReactNode }) {
  const { activeProjectId, reloadToken } = useProject();
  const { register, record } = useHistory();
  const [cells, setCells] = useState<GenCellData[]>([]);
  const [dirty, setDirty] = useState(false);

  // Manual save only. Auto-save was dropped because the debounced async writes
  // raced each other (full DELETE-then-reinsert) and the last change before an
  // app close was lost. Now the board only hits the DB when the user presses
  // Ctrl+S. `readyRef` gates out marking dirty during hydration; `cellsRef`
  // keeps the latest board for the keyboard handler without stale closures.
  const readyRef = useRef(false);
  const cellsRef = useRef(cells);
  cellsRef.current = cells;

  // Register this area on the unified undo/redo timeline. Snapshots are JSON
  // deep-clones of the cell array; restore is a plain setState. Only structural
  // mutations call record() below — note text edits are handled by Tiptap.
  useEffect(() => {
    register('gen', {
      snapshot: () => JSON.parse(JSON.stringify(cellsRef.current)),
      restore: (data) => setCells(data as GenCellData[]),
    });
  }, [register]);

  // Hydrate on project switch. Unsaved changes in the outgoing project are
  // discarded — that is the trade-off of manual save.
  useEffect(() => {
    readyRef.current = false;
    setDirty(false);
    if (activeProjectId == null) {
      setCells([]);
      return;
    }
    const pid = activeProjectId;
    let cancelled = false;
    (async () => {
      try {
        const loaded = await loadGenCells(pid);
        if (cancelled) return;
        setCells(
          loaded.map((c) => ({
            id: c.id,
            note: c.note ? (JSON.parse(c.note) as JSONContent) : null,
            images: c.slots.map((s) => ({
              id: s.id,
              mediaId: s.media_id,
              name: s.name,
              thumb: s.thumb ?? '',
              path: s.path ?? '',
              meta: s.meta ?? '',
              type: s.type,
            })),
          }))
        );
      } catch (err) {
        console.error('Failed to load gen cells', err);
        if (!cancelled) setCells([]);
      } finally {
        if (!cancelled) readyRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, reloadToken]);

  // Any post-hydration change marks the board dirty (unsaved).
  useEffect(() => {
    if (!readyRef.current) return;
    setDirty(true);
  }, [cells]);

  const save = useCallback(async () => {
    if (activeProjectId == null) return;
    const pid = activeProjectId;
    try {
      await saveGenCells(
        pid,
        cellsRef.current.map((c) => ({
          id: c.id,
          note: c.note ? JSON.stringify(c.note) : null,
          slots: c.images.map((it) => ({
            id: it.id,
            media_id: it.mediaId,
            name: it.name,
            thumb: it.thumb || null,
            path: it.path || null,
            meta: it.meta || null,
            type: it.type,
          })),
        }))
      );
      setDirty(false);
    } catch (err) {
      console.error('Failed to save gen cells', err);
    }
  }, [activeProjectId]);

  // B7: the Ctrl+S / Cmd+S shortcut is now handled by a SINGLE global handler
  // in App's top bar, which fans out to every store's save via the combined
  // save(). Registering it here too made the shortcut fire three times (one per
  // store) — each doing a full DELETE+reinsert — so the per-store handler was
  // removed. `save` stays exported for that central handler and the Save button.

  const addImageToCell = useCallback((cellId: string, item: GenImageItem) => {
    record('gen');
    setCells((prev) =>
      prev.map((c) =>
        c.id === cellId ? { ...c, images: [...c.images, item] } : c
      )
    );
  }, [record]);

  const newCellWithImage = useCallback((item: GenImageItem) => {
    record('gen');
    const id = rid('cell');
    setCells((prev) => [...prev, { id, images: [item], note: null }]);
    return id;
  }, [record]);

  // B5: append an empty cell (no images) that the user can type a note into or
  // drag materials into later. Note: deleteImage auto-removes a cell only when
  // its LAST image is deleted; an all-empty cell created here has no images to
  // delete, so it persists until the user removes it via 删除此格子.
  const newEmptyCell = useCallback(() => {
    record('gen');
    setCells((prev) => [
      ...prev,
      { id: rid('cell'), images: [], note: null },
    ]);
  }, [record]);

  const reorderInCell = useCallback(
    (cellId: string, from: number, to: number) => {
      record('gen');
      setCells((prev) =>
        prev.map((c) => {
          if (c.id !== cellId) return c;
          if (to < 0 || to >= c.images.length || from === to) return c;
          const next = [...c.images];
          const [moved] = next.splice(from, 1);
          next.splice(to, 0, moved);
          return { ...c, images: next };
        })
      );
    },
    [record]
  );

  const deleteImage = useCallback((cellId: string, slotId: string) => {
    record('gen');
    setCells((prev) =>
      prev
        .map((c) =>
          c.id === cellId
            ? { ...c, images: c.images.filter((it) => it.id !== slotId) }
            : c
        )
        // A cell with no images left is removed.
        .filter((c) => c.images.length > 0)
    );
  }, [record]);

  // Card-level reorder: move a whole cell up/down within the list.
  const reorderCells = useCallback((from: number, to: number) => {
    record('gen');
    setCells((prev) => {
      if (from === to || from < 0 || to < 0 || from >= prev.length || to >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, [record]);

  const deleteCell = useCallback((cellId: string) => {
    record('gen');
    setCells((prev) => prev.filter((c) => c.id !== cellId));
  }, [record]);

  const setNote = useCallback((cellId: string, note: JSONContent) => {
    setCells((prev) =>
      prev.map((c) => (c.id === cellId ? { ...c, note } : c))
    );
  }, []);

  const renameMedia = useCallback((mediaId: number, name: string) => {
    setCells((prev) =>
      prev.map((c) => ({
        ...c,
        images: c.images.map((it) =>
          it.mediaId === mediaId ? { ...it, name } : it
        ),
      }))
    );
  }, []);

  return (
    <GenStoreContext.Provider
      value={{
        cells,
        dirty,
        save,
        addImageToCell,
        newCellWithImage,
        newEmptyCell,
        reorderInCell,
        reorderCells,
        deleteImage,
        deleteCell,
        setNote,
        renameMedia,
      }}
    >
      {children}
    </GenStoreContext.Provider>
  );
}
