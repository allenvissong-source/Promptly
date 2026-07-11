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
  save: () => Promise<void>;
  addBlock: () => void;
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

  const readyRef = useRef(false);
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
    readyRef.current = false;
    setDirty(false);
    if (activeProjectId == null) {
      setBlocks([]);
      return;
    }
    const pid = activeProjectId;
    let cancelled = false;
    (async () => {
      try {
        const loaded = await loadBlocks(pid);
        if (cancelled) return;
        setBlocks(
          loaded.map((b) => ({
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
          }))
        );
      } catch (err) {
        console.error('Failed to load blocks', err);
        if (!cancelled) setBlocks([]);
      } finally {
        if (!cancelled) readyRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, reloadToken]);

  useEffect(() => {
    if (!readyRef.current) return;
    setDirty(true);
  }, [blocks]);

  const save = useCallback(async () => {
    if (activeProjectId == null) return;
    const pid = activeProjectId;
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
      console.error('Failed to save blocks', err);
    }
  }, [activeProjectId]);

  // B7: Ctrl+S is handled by ONE global handler in App's top bar (combined save
  // across all stores); the per-store handler was removed so the shortcut fires
  // only once. `save` stays exported for that central handler and the button.

  const addBlock = useCallback(() => {
    record('blk');
    setBlocks((prev) => [
      ...prev,
      { id: rid('blk'), content: null, combineEnabled: false, images: [] },
    ]);
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
        save,
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
