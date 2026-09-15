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
import { loadBlocks, saveBlocks } from '../lib/db';

// One block in the 分镜区 (storyboard area): a Tiptap doc that assembles image
// references and @template references into a final storyboard text, plus its
// own ordered image list (mirrors a template). combineEnabled toggles the @
// dual-tab picker (image + template) for this block.
export interface BlockData {
  id: string;
  content: JSONContent | null;
  combineEnabled: boolean;
  images: GenImageItem[];
}

interface BlockStoreValue {
  blocks: BlockData[];
  dirty: boolean;
  // 见 GenStoreContext：内存里这份 blocks 是从哪个项目 hydrate 出来的。
  hydratedProjectId: number | null;
  save: (expectProjectId?: number) => Promise<void>;
  markSaved: () => void;
  addBlock: () => string;
  deleteBlock: (id: string) => void;
  // Duplicate a block (copied content/combine flag/images with fresh slot ids)
  // and insert it right after the source.
  duplicateBlock: (id: string) => void;
  setContent: (id: string, content: JSONContent) => void;
  setCombineEnabled: (id: string, value: boolean) => void;
  // Append an image to a block's list, deduped by media id. Returns the
  // resolved left-list item (deterministic slot id) for chip slotId reuse.
  addImageToBlock: (blockId: string, item: GenImageItem) => GenImageItem;
  // Create a new block seeded with one image (drag onto blank area).
  // Returns the new block id so a multi-image drop can append the rest.
  newBlockWithImage: (item: GenImageItem) => string;
  reorderInBlock: (blockId: string, from: number, to: number) => void;
  // Reorder the blocks themselves (card-level up/down drag).
  reorderBlocks: (from: number, to: number) => void;
  deleteImageFromBlock: (blockId: string, slotId: string) => void;
  // Sync image names when a material is renamed in the library.
  renameMedia: (mediaId: number, name: string) => void;
}

const BlockStoreContext = createContext<BlockStoreValue | null>(null);

export function useBlockStore(): BlockStoreValue {
  const ctx = useContext(BlockStoreContext);
  if (!ctx) throw new Error('useBlockStore must be used within BlockStoreProvider');
  return ctx;
}

const rid = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

// Deterministic slot id per (block, media): keeps the @-inserted chip's slotId
// equal to the backfilled left-list slot's id.
const bslotId = (blockId: string, mediaId: number) => `bslot-${blockId}-${mediaId}`;

export function BlockStoreProvider({ children }: { children: ReactNode }) {
  const { activeProjectId, reloadToken } = useProject();
  const { register, record } = useHistory();
  const [blocks, setBlocks] = useState<BlockData[]>([]);
  const [dirty, setDirty] = useState(false);

  // 与 GenStore 同构：hydratedForRef 既当 dirty 门闸，也当 save() 的写入目标。
  const hydratedForRef = useRef<number | null>(null);
  const [hydratedProjectId, setHydratedProjectId] = useState<number | null>(null);
  // 见 GenStoreContext：hydrate 自己写进来的那份数组，用来把「hydrate 结束后必然
  // 跑一次的 dirty 效果」认出来，避免每次打开项目都被当成用户改动。
  const hydratedBlocksRef = useRef<BlockData[] | null>(null);
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;

  // Register on the unified undo/redo timeline (structural changes only).
  useEffect(() => {
    register('blk', {
      snapshot: () => JSON.parse(JSON.stringify(blocksRef.current)),
      restore: (data) => setBlocks(data as BlockData[]),
    });
  }, [register]);

  useEffect(() => {
    hydratedForRef.current = null;
    setHydratedProjectId(null);
    setDirty(false);
    if (activeProjectId == null) {
      const empty: BlockData[] = [];
      hydratedBlocksRef.current = empty;
      setBlocks(empty);
      return;
    }
    const pid = activeProjectId;
    let cancelled = false;
    (async () => {
      try {
        const loaded = await loadBlocks(pid);
        if (cancelled) return;
        const hydrated: BlockData[] = loaded.map((b) => ({
          id: b.id,
          content: b.content ? (JSON.parse(b.content) as JSONContent) : null,
          combineEnabled: b.combineEnabled,
          images: b.slots.map((s) => ({
            id: s.id,
            mediaId: s.media_id,
            name: s.name,
            thumb: s.thumb ?? '',
            path: s.path ?? '',
            meta: s.meta ?? '',
            type: s.type,
          })),
        }));
        hydratedBlocksRef.current = hydrated;
        setBlocks(hydrated);
      } catch (err) {
        console.error('Failed to load blocks', err);
        if (!cancelled) {
          const empty: BlockData[] = [];
          hydratedBlocksRef.current = empty;
          setBlocks(empty);
        }
      } finally {
        // cancelled 说明项目又切走了：不开门闸。
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

  useEffect(() => {
    if (hydratedForRef.current == null) return;
    // hydrate 刚写进来的那份数据不算用户改动（无脏不写）。
    if (hydratedBlocksRef.current === blocks) return;
    setDirty(true);
  }, [blocks]);

  const markSaved = useCallback(() => setDirty(false), []);

  const save = useCallback(async (expectProjectId?: number) => {
    const pid = hydratedForRef.current;
    // ⚠️ hydrate 未完成 / 串项目：拒绝写。
    if (pid == null) return;
    if (expectProjectId != null && expectProjectId !== pid) return;
    try {
      await saveBlocks(
        pid,
        blocksRef.current.map((b) => ({
          id: b.id,
          content: b.content ? JSON.stringify(b.content) : null,
          combineEnabled: b.combineEnabled,
          slots: b.images.map((it) => ({
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
      // 失败向上抛（保留日志），由编排层显示「保存失败」并保持 dirty=true。
      console.error('Failed to save blocks', err);
      throw err;
    }
  }, []);

  // B7: Ctrl+S is handled by ONE global handler in App's top bar (combined save
  // across all stores); the per-store handler was removed so the shortcut fires
  // only once. `save` stays exported for that central handler and the button.

  // 返回新卡片的 id，让调用方能紧接着往里写内容（MCP 的「新建并填充」需要它）。
  // 与 newBlockWithImage 的做法一致：id 在这里就地生成，不依赖后续渲染。
  const addBlock = useCallback(() => {
    record('blk');
    const id = rid('blk');
    setBlocks((prev) => [
      ...prev,
      { id, content: null, combineEnabled: false, images: [] },
    ]);
    return id;
  }, [record]);

  const deleteBlock = useCallback((id: string) => {
    record('blk');
    setBlocks((prev) => prev.filter((b) => b.id !== id));
  }, [record]);

  // Duplicate a block: deep-copy content/combine flag/images, mint a fresh blk
  // id, and re-derive every slot id for the new block (slot ids are
  // deterministic per (block, media), so reusing the source's would collide).
  // The copy lands directly after the source.
  const duplicateBlock = useCallback((id: string) => {
    record('blk');
    setBlocks((prev) => {
      const idx = prev.findIndex((b) => b.id === id);
      if (idx < 0) return prev;
      const src = prev[idx];
      const newId = rid('blk');
      const copy: BlockData = {
        id: newId,
        content: src.content ? JSON.parse(JSON.stringify(src.content)) : null,
        combineEnabled: src.combineEnabled,
        images: src.images.map((it) => ({
          ...it,
          id: bslotId(newId, it.mediaId),
        })),
      };
      const next = [...prev];
      next.splice(idx + 1, 0, copy);
      return next;
    });
  }, [record]);

  const setContent = useCallback((id: string, content: JSONContent) => {
    setBlocks((prev) => prev.map((b) => (b.id === id ? { ...b, content } : b)));
  }, []);

  const setCombineEnabled = useCallback((id: string, value: boolean) => {
    record('blk');
    setBlocks((prev) =>
      prev.map((b) => (b.id === id ? { ...b, combineEnabled: value } : b))
    );
  }, [record]);

  const addImageToBlock = useCallback(
    (blockId: string, item: GenImageItem): GenImageItem => {
      const resolved = { ...item, id: bslotId(blockId, item.mediaId) };
      record('blk');
      setBlocks((prev) =>
        prev.map((b) => {
          if (b.id !== blockId) return b;
          if (b.images.some((it) => it.mediaId === item.mediaId)) return b;
          return { ...b, images: [...b.images, resolved] };
        })
      );
      return resolved;
    },
    [record]
  );

  const newBlockWithImage = useCallback((item: GenImageItem) => {
    record('blk');
    const id = rid('blk');
    setBlocks((prev) => [
      ...prev,
      {
        id,
        content: null,
        combineEnabled: false,
        images: [{ ...item, id: bslotId(id, item.mediaId) }],
      },
    ]);
    return id;
  }, [record]);

  const reorderInBlock = useCallback(
    (blockId: string, from: number, to: number) => {
      record('blk');
      setBlocks((prev) =>
        prev.map((b) => {
          if (b.id !== blockId) return b;
          if (to < 0 || to >= b.images.length || from === to) return b;
          const next = [...b.images];
          const [moved] = next.splice(from, 1);
          next.splice(to, 0, moved);
          return { ...b, images: next };
        })
      );
    },
    [record]
  );

  // Card-level reorder: move a whole block up/down within the list.
  const reorderBlocks = useCallback((from: number, to: number) => {
    record('blk');
    setBlocks((prev) => {
      if (from === to || from < 0 || to < 0 || from >= prev.length || to >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, [record]);

  const deleteImageFromBlock = useCallback(
    (blockId: string, slotId: string) => {
      record('blk');
      setBlocks((prev) =>
        prev.map((b) =>
          b.id === blockId
            ? { ...b, images: b.images.filter((it) => it.id !== slotId) }
            : b
        )
      );
    },
    [record]
  );

  const renameMedia = useCallback((mediaId: number, name: string) => {
    setBlocks((prev) =>
      prev.map((b) => ({
        ...b,
        images: b.images.map((it) =>
          it.mediaId === mediaId ? { ...it, name } : it
        ),
      }))
    );
  }, []);

  return (
    <BlockStoreContext.Provider
      value={{
        blocks,
        dirty,
        hydratedProjectId,
        save,
        markSaved,
        addBlock,
        deleteBlock,
        duplicateBlock,
        setContent,
        setCombineEnabled,
        addImageToBlock,
        newBlockWithImage,
        reorderInBlock,
        reorderBlocks,
        deleteImageFromBlock,
        renameMedia,
      }}
    >
      {children}
    </BlockStoreContext.Provider>
  );
}
