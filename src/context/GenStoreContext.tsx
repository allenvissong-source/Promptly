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
  // 内存里这份 cells 是从哪个项目 hydrate 出来的。null = 还没 hydrate 完成
  // （或正在切项目），此刻 cells 是「空的初始态」，任何写库都会清空用户项目。
  // 自动保存调度器用它当 ready 门闸，save() 自己也再校验一次。
  hydratedProjectId: number | null;
  // expectProjectId：调用方以为自己在存哪个项目。传了就必须与实际 hydrate 的项目
  // 一致，否则拒绝写 —— 杜绝「把 A 项目内容写进 B 项目」。
  save: (expectProjectId?: number) => Promise<void>;
  // 保存成功后由编排层调用（自动保存写完 / 快照还原后）。
  markSaved: () => void;
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

  // 自动保存（v7）：调度逻辑集中在 AutoSaveContext + lib/autoSave.ts 的纯状态机，
  // 这里只负责「内存 -> 库」的那一步，以及暴露 hydrate 完成信号。
  // hydratedForRef 取代了原来的布尔 readyRef：不仅表示「hydrate 完成了」，还记住
  // 「完成的是哪个项目」，save() 一律写这个 id，绝不用 activeProjectId（切项目瞬间
  // activeProjectId 可能已经指向新项目，而内存里还是旧项目的内容）。
  const hydratedForRef = useRef<number | null>(null);
  const [hydratedProjectId, setHydratedProjectId] = useState<number | null>(null);
  // hydrate 自己 setCells 的那个数组。React 会把「setCells + 开门闸」批成同一次
  // 渲染，所以下面的 dirty 效果在 hydrate 结束后一定会跑一次；用身份比较把它认出来，
  // 否则每次打开项目都会立刻变脏，自动保存又会把刚读出来的东西原样写回去。
  const hydratedCellsRef = useRef<GenCellData[] | null>(null);
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

  // Hydrate on project switch. 未保存内容不再静默丢弃：切项目前由 AutoSaveContext
  // 先 flush 一次（用旧 projectId），这里只负责加载新项目。
  useEffect(() => {
    hydratedForRef.current = null;
    setHydratedProjectId(null);
    setDirty(false);
    if (activeProjectId == null) {
      const empty: GenCellData[] = [];
      hydratedCellsRef.current = empty;
      setCells(empty);
      return;
    }
    const pid = activeProjectId;
    let cancelled = false;
    (async () => {
      try {
        const loaded = await loadGenCells(pid);
        if (cancelled) return;
        const hydrated: GenCellData[] = loaded.map((c) => ({
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
        }));
        hydratedCellsRef.current = hydrated;
        setCells(hydrated);
      } catch (err) {
        console.error('Failed to load gen cells', err);
        if (!cancelled) {
          const empty: GenCellData[] = [];
          hydratedCellsRef.current = empty;
          setCells(empty);
        }
      } finally {
        // 只有 hydrate 真正跑完（含失败兜底成空列表）才开门闸。cancelled 的那次
        // 说明项目又切走了，绝不能开门 —— 否则会把上一个项目的内存写进新项目。
        if (!cancelled) {
          hydratedForRef.current = pid;
          setHydratedProjectId(pid);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, reloadToken]);

  // Any post-hydration change marks the board dirty (unsaved).
  useEffect(() => {
    if (hydratedForRef.current == null) return;
    // hydrate 刚写进来的那份数据不算用户改动（无脏不写）。
    if (hydratedCellsRef.current === cells) return;
    setDirty(true);
  }, [cells]);

  const markSaved = useCallback(() => setDirty(false), []);

  const save = useCallback(async (expectProjectId?: number) => {
    // 写库一律用 hydrate 出来的那个项目 id，不用 activeProjectId。
    const pid = hydratedForRef.current;
    // ⚠️ hydrate 未完成一律拒绝写：此刻 cells 是空的初始态。
    if (pid == null) return;
    // ⚠️ 串项目守卫：调用方期望的项目与内存实际归属不一致时拒绝写。
    if (expectProjectId != null && expectProjectId !== pid) return;
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
      // 失败不再被吞掉：保留原有日志，同时向上抛，让编排层显示「保存失败」并保持
      // dirty=true 等下一轮重试。
      console.error('Failed to save gen cells', err);
      throw err;
    }
  }, []);

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
        hydratedProjectId,
        save,
        markSaved,
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
