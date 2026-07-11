import { useRef, useCallback, useEffect, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Plus, Trash2, Clapperboard, Copy, GripVertical } from 'lucide-react';
import { useBlockStore } from '../../context/BlockStoreContext';
import { useGenTemplateStore } from '../../context/GenTemplateStoreContext';
import { useProject } from '../../context/ProjectContext';
import { useDrag, type DragPayload, type DragItem } from '../../context/DragContext';
import { useMediaRevision } from '../../context/MediaRevisionContext';
import type { GenImageItem } from '../../context/GenImagesContext';
import { rolesOf, roleBoundImage, expandTemplateRef } from './roleUtils';
import { listMedia } from '../../lib/db';
import type { TemplateCandidate } from './mentionSuggestion';
import type { ResolvedTemplateRef } from './GenPromptEditor';
import type { ChipMode } from '../../context/GenSettingsContext';
import ClipNoteCard from './ClipNoteCard';
import { useCardReorder } from './useCardReorder';

// The 分镜区 (right panel). Mirrors the template area: a "分镜 / 添加分镜" header
// above a vertical list of block cards. Each block reuses ClipNoteCard (fixed
// image column + wide text). A per-card "组合模式" checkbox toggles the @ picker
// between image-only and image/template dual tabs. Picking an @template inserts
// a reference chip whose role checkboxes pull the checked role's bound image
// into this block's left list. Copying expands @template refs into
// `# 模板名` + `- 角色名` blocks.
export default function StoryboardArea() {
  const {
    blocks,
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
  } = useBlockStore();
  const { templates } = useGenTemplateStore();
  const { dragPayload, pointer, subscribeDrop } = useDrag();
  const { activeProjectId } = useProject();
  const { rev: mediaRev } = useMediaRevision();
  const startCardReorder = useCardReorder('data-block-id', reorderBlocks);

  const templatesRef = useRef(templates);
  templatesRef.current = templates;

  const panelRef = useRef<HTMLDivElement>(null);

  // The project's whole image library, used only as the @ candidate pool so a
  // block can @-reference any project image (not just those already in its left
  // list). Picking one backfills the block via addImageToBlock (deduped by
  // media id). Mirrors TemplateArea's pool wiring.
  const [pool, setPool] = useState<GenImageItem[]>([]);
  const poolRef = useRef(pool);
  poolRef.current = pool;

  // The global (通用) image library, shown as the second @ tab. Spans every
  // folder in the common scope (allFolders), mirroring TemplateArea.
  const [commonPool, setCommonPool] = useState<GenImageItem[]>([]);
  const commonPoolRef = useRef(commonPool);
  commonPoolRef.current = commonPool;

  useEffect(() => {
    if (activeProjectId == null) {
      setPool([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const images = await listMedia({ scope: 'project', projectId: activeProjectId, type: 'image' });
        if (cancelled) return;
        setPool(
          images.map((m) => ({
            id: `blk-pool-${m.id}`,
            mediaId: m.id,
            name: m.name,
            thumb: m.thumb ? convertFileSrc(m.thumb) : '',
            path: m.path,
            meta: m.size ?? '',
            type: 'image' as const,
          }))
        );
      } catch (err) {
        console.error('Failed to load block image pool', err);
        if (!cancelled) setPool([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, mediaRev]);

  // Global pool is project-independent (all common-scope images). Reloads on
  // mediaRev so library edits (import/move/delete/rename) stay in sync.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const images = await listMedia({ scope: 'common', type: 'image', allFolders: true });
        if (cancelled) return;
        setCommonPool(
          images.map((m) => ({
            id: `blk-common-${m.id}`,
            mediaId: m.id,
            name: m.name,
            thumb: m.thumb ? convertFileSrc(m.thumb) : '',
            path: m.path,
            meta: m.size ?? '',
            type: 'image' as const,
          }))
        );
      } catch (err) {
        console.error('Failed to load block common image pool', err);
        if (!cancelled) setCommonPool([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mediaRev]);

  // Two @ image tabs: 项目 and 全局. The 模板 tab is added by the picker itself
  // when combine mode is on (via getTemplateCandidates + isCombine).
  const imagePools = useCallback(
    () => [
      { key: 'project', label: '项目', getItems: () => poolRef.current },
      { key: 'common', label: '全局', getItems: () => commonPoolRef.current },
    ],
    []
  );

  // Live @-template candidates: every referenceable template, with a live role
  // count. Read from the ref so the (once-built) suggestion config stays fresh.
  const templateCandidates = useCallback((): TemplateCandidate[] => {
    return templatesRef.current
      .filter((t) => t.referenceable)
      .map((t) => ({
        kind: 'template' as const,
        id: t.id,
        name: t.name,
        roleCount: rolesOf(t.content).length,
      }));
  }, []);

  // Resolve an @template ref for copy/serialize: delegates to the pure
  // expandTemplateRef, which builds the `# 模板名` header + kept content lines
  // (checked-role + plain-text lines, mention -> Image{n} against THIS BLOCK's
  // image list) and reports whether the template ends with a trailing empty
  // paragraph (the Rule-2 signal).
  const resolveTemplateRef = useCallback(
    (
      templateId: string,
      selectedRoleIds: string[],
      blockImages: GenImageItem[],
      mode: ChipMode
    ): ResolvedTemplateRef | null => {
      const t = templatesRef.current.find((x) => x.id === templateId);
      if (!t) return null;
      return expandTemplateRef(
        {
          name: t.name,
          includeTitle: t.includeTitle,
          content: t.content,
        },
        selectedRoleIds,
        blockImages,
        mode
      );
    },
    []
  );

  // When a role checkbox is turned on, pull that role's bound image (resolved
  // against the template's own image list) into this block, deduped by media.
  const handleRoleChecked = useCallback(
    (blockId: string, templateId: string, roleId: string) => {
      const t = templatesRef.current.find((x) => x.id === templateId);
      if (!t) return;
      const img = roleBoundImage(t.content, roleId, t.images);
      if (img) addImageToBlock(blockId, img);
    },
    [addImageToBlock]
  );

  // Live drop-target highlight (recomputed from the pointer each render).
  const insidePanel = (() => {
    if (!dragPayload) return false;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return false;
    const { x, y } = pointer;
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  })();

  const blockIdAtPoint = (x: number, y: number): string => {
    const el = document.elementFromPoint(x, y);
    const cardEl = el?.closest('[data-block-id]') as HTMLElement | null;
    return cardEl?.dataset.blockId ?? '';
  };

  const dropTarget =
    dragPayload && insidePanel ? blockIdAtPoint(pointer.x, pointer.y) : '';
  const frameOver = !!dragPayload && insidePanel;

  const dragItemToItem = useCallback(
    (d: DragItem): GenImageItem => ({
      id: `blk-drop-${d.mediaId}`,
      mediaId: d.mediaId,
      name: d.name,
      thumb: d.thumb || '',
      path: d.path || '',
      meta: d.meta || '',
      type: d.type,
    }),
    []
  );
  const payloadToItems = useCallback(
    (payload: DragPayload): GenImageItem[] => {
      const src = payload.items && payload.items.length > 0 ? payload.items : [payload];
      return src.map(dragItemToItem);
    },
    [dragItemToItem]
  );

  // Route the drop: onto a block card -> append; onto blank area -> new one.
  useDropRouter(panelRef, subscribeDrop, (payload, x, y) => {
    const items = payloadToItems(payload);
    if (items.length === 0) return;
    const targetId = blockIdAtPoint(x, y);
    if (targetId) {
      items.forEach((it) => addImageToBlock(targetId, it));
    } else {
      const [first, ...rest] = items;
      const newId = newBlockWithImage(first);
      rest.forEach((it) => addImageToBlock(newId, it));
    }
  });

  return (
    <div className="flex flex-col h-full w-full bg-[#252525] rounded-sm overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#3D3D3D] shrink-0">
        <span className="text-[13px] text-[#8A8A8A] font-medium">分镜</span>
        <button
          onClick={addBlock}
          className="flex items-center gap-1 px-3 h-8 bg-[#2EC4B6] text-white text-[12px] rounded-lg hover:bg-[#25A99C] transition-colors cursor-pointer"
        >
          <Plus size={12} strokeWidth={2.5} />
          <span>添加分镜</span>
        </button>
      </div>

      <div
        ref={panelRef}
        className={`scrollbar-dark flex-1 overflow-y-auto overflow-x-hidden p-3 space-y-2 transition-colors duration-200 ${
          frameOver && !dropTarget ? 'bg-[#2EC4B6]/5' : ''
        }`}
      >
        {blocks.length === 0 ? (
          <div
            className={`flex flex-col items-center justify-center h-full gap-3 select-none transition-colors ${
              frameOver ? 'text-[#2EC4B6]' : 'text-[#555555]'
            }`}
          >
            <Clapperboard size={32} strokeWidth={1.5} />
            <span className="text-[13px]">
              点击“添加分镜”，或拖动素材到此处新建分镜
            </span>
          </div>
        ) : (
          <>
            {blocks.map((b, i) => (
              <div key={b.id} data-block-id={b.id} className="min-w-0">
                <ClipNoteCard
                  images={b.images}
                  cardId={b.id}
                  note={b.content}
                  dragOver={dropTarget === b.id}
                  imageColClassName="w-[180px]"
                  textColClassName="flex-1"
                  getImagePools={imagePools}
                  onPick={(item) => addImageToBlock(b.id, item)}
                  enableRoleEntity
                  enableTemplateRef
                  isCombine={() => b.combineEnabled}
                  getTemplateCandidates={templateCandidates}
                  resolveTemplateRef={resolveTemplateRef}
                  onRoleChecked={(templateId, roleId) =>
                    handleRoleChecked(b.id, templateId, roleId)
                  }
                  header={
                    <BlockHeader
                      index={i}
                      combineEnabled={b.combineEnabled}
                      onHandlePointerDown={(e) =>
                        startCardReorder(e, blocks.findIndex((x) => x.id === b.id))
                      }
                      onToggleCombine={() =>
                        setCombineEnabled(b.id, !b.combineEnabled)
                      }
                      onDuplicate={() => duplicateBlock(b.id)}
                      onDelete={() => deleteBlock(b.id)}
                    />
                  }
                  onReorder={(from, to) => reorderInBlock(b.id, from, to)}
                  onDeleteImage={(slotId) => deleteImageFromBlock(b.id, slotId)}
                  onNoteChange={(json) => setContent(b.id, json)}
                />
              </div>
            ))}
            <div
              className={`shrink-0 min-h-[72px] flex items-center justify-center rounded-md border border-dashed text-[12px] select-none transition-colors ${
                frameOver && !dropTarget
                  ? 'border-[#2EC4B6] text-[#2EC4B6] bg-[#2EC4B6]/5'
                  : 'border-[#3D3D3D] text-[#555555]'
              }`}
            >
              拖动素材到此处新建分镜
            </div>
          </>
        )}
      </div>
    </div>
  );
}

interface BlockHeaderProps {
  index: number;
  combineEnabled: boolean;
  onHandlePointerDown?: (e: React.PointerEvent) => void;
  onToggleCombine: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

// Block card top bar: an index label, the 组合模式 checkbox (default off; when
// on the @ picker gains the 模板 tab), and a delete button.
function BlockHeader({
  index,
  combineEnabled,
  onHandlePointerDown,
  onToggleCombine,
  onDuplicate,
  onDelete,
}: BlockHeaderProps) {
  return (
    <div className="group/blk flex items-center justify-between px-2.5 py-1.5 border-b border-[#3D3D3D]">
      <span className="flex items-center gap-1 text-[12px] text-[#E5E5E5] font-medium">
        {onHandlePointerDown && (
          <span
            onPointerDown={onHandlePointerDown}
            className="shrink-0 cursor-grab active:cursor-grabbing select-none opacity-0 group-hover/card:opacity-100 transition-opacity"
            title="拖动排序"
          >
            <GripVertical size={12} className="text-[#555555]" />
          </span>
        )}
        分镜 {index + 1}
      </span>
      <div className="flex items-center gap-2 shrink-0">
        <label
          className="flex items-center gap-1 cursor-pointer text-[11px] text-[#8A8A8A] select-none"
          title="组合模式：开启后 @ 可引用模板"
        >
          <input
            type="checkbox"
            checked={combineEnabled}
            onChange={onToggleCombine}
            className="checkbox-dark"
          />
          <span className={combineEnabled ? 'text-[#2EC4B6]' : ''}>组合模式</span>
        </label>
        <button
          className="p-0.5 rounded text-[#555555] hover:text-[#2EC4B6] hover:bg-[#444444] transition-all opacity-0 group-hover/blk:opacity-100"
          onClick={onDuplicate}
          title="复制此分镜"
        >
          <Copy size={11} />
        </button>
        <button
          className="p-0.5 rounded text-[#555555] hover:text-red-400 hover:bg-[#444444] transition-all opacity-0 group-hover/blk:opacity-100"
          onClick={onDelete}
          title="删除此分镜"
        >
          <Trash2 size={11} />
        </button>
      </div>
    </div>
  );
}

// Subscribe to pointer-drop events and route those that land inside the panel.
// Kept as a tiny hook so the effect deps stay honest.
function useDropRouter(
  panelRef: React.RefObject<HTMLDivElement | null>,
  subscribeDrop: (cb: (payload: DragPayload, x: number, y: number) => void) => () => void,
  onDrop: (payload: DragPayload, x: number, y: number) => void
) {
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  useEffect(() => {
    const unsub = subscribeDrop((payload, x, y) => {
      const rect = panelRef.current?.getBoundingClientRect();
      if (!rect) return;
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
      onDropRef.current(payload, x, y);
    });
    return unsub;
  }, [subscribeDrop, panelRef]);
}
