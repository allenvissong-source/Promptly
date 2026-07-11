import { useState, useRef, useEffect, useCallback } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Plus, Trash2, Pencil, LayoutTemplate, Eye, EyeOff, Hash, Copy, GripVertical } from 'lucide-react';
import { useProject } from '../../context/ProjectContext';
import { useGenTemplateStore } from '../../context/GenTemplateStoreContext';
import { useDrag, type DragPayload, type DragItem } from '../../context/DragContext';
import { useMediaRevision } from '../../context/MediaRevisionContext';
import type { GenImageItem } from '../../context/GenImagesContext';
import { listMedia } from '../../lib/db';
import ClipNoteCard from './ClipNoteCard';
import { useCardReorder } from './useCardReorder';

// The 模板区 (middle panel). Mirrors the notes panel: a "模板 / 添加模板" header
// above a vertical list of template cards. Each card reuses ClipNoteCard but
// with reversed proportions — a fixed 180px image column on the left and the
// text (the template body) filling the rest on the right. A card line like
// `零：@Image1` references an image in THIS template's left list; ordinals
// restart at 1 per template. The @ candidate pool is the whole project image
// library, and picking one (or dragging it in) backfills the left list, deduped
// by media id. Slot ids are deterministic per (template, media) so chips
// survive reload.
export default function TemplateArea() {
  const { activeProjectId } = useProject();
  const {
    templates,
    addTemplate,
    deleteTemplate,
    duplicateTemplate,
    renameTemplate,
    setContent,
    setReferenceable,
    setIncludeTitle,
    addImageToTemplate,
    newTemplateWithImage,
    reorderInTemplate,
    reorderTemplates,
    deleteImageFromTemplate,
  } = useGenTemplateStore();
  const { dragPayload, pointer, subscribeDrop } = useDrag();
  const { rev: mediaRev } = useMediaRevision();
  const startCardReorder = useCardReorder('data-template-id', reorderTemplates);

  // The project's whole image library, used only as the @ candidate pool.
  const [pool, setPool] = useState<GenImageItem[]>([]);
  const poolRef = useRef(pool);
  poolRef.current = pool;

  // The global (通用) image library, shown as the second @ tab. Spans every
  // folder in the common scope (allFolders), not just its root.
  const [commonPool, setCommonPool] = useState<GenImageItem[]>([]);
  const commonPoolRef = useRef(commonPool);
  commonPoolRef.current = commonPool;

  const panelRef = useRef<HTMLDivElement>(null);

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
            id: `tpl-pool-${m.id}`,
            mediaId: m.id,
            name: m.name,
            thumb: m.thumb ? convertFileSrc(m.thumb) : '',
            path: m.path,
            meta: m.size ?? '',
            type: 'image' as const,
          }))
        );
      } catch (err) {
        console.error('Failed to load template image pool', err);
        if (!cancelled) setPool([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, mediaRev]);

  // Global pool is project-independent (all common-scope images, across every
  // folder) so the @ 全局 tab lists them. Reloads on mediaRev so library edits
  // (import/move/delete/rename) stay in sync.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const images = await listMedia({ scope: 'common', type: 'image', allFolders: true });
        if (cancelled) return;
        setCommonPool(
          images.map((m) => ({
            id: `tpl-common-${m.id}`,
            mediaId: m.id,
            name: m.name,
            thumb: m.thumb ? convertFileSrc(m.thumb) : '',
            path: m.path,
            meta: m.size ?? '',
            type: 'image' as const,
          }))
        );
      } catch (err) {
        console.error('Failed to load template common image pool', err);
        if (!cancelled) setCommonPool([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mediaRev]);

  // Two @ tabs: 项目 (this project's images) and 全局 (common scope, all folders).
  const imagePools = useCallback(
    () => [
      { key: 'project', label: '项目', getItems: () => poolRef.current },
      { key: 'common', label: '全局', getItems: () => commonPoolRef.current },
    ],
    []
  );

  // Live drop-target highlight (recomputed from the pointer each render).
  const insidePanel = (() => {
    if (!dragPayload) return false;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return false;
    const { x, y } = pointer;
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  })();

  const templateIdAtPoint = (x: number, y: number): string => {
    const el = document.elementFromPoint(x, y);
    const cardEl = el?.closest('[data-template-id]') as HTMLElement | null;
    return cardEl?.dataset.templateId ?? '';
  };

  const dropTarget =
    dragPayload && insidePanel ? templateIdAtPoint(pointer.x, pointer.y) : '';
  const frameOver = !!dragPayload && insidePanel;

  const dragItemToItem = useCallback(
    (d: DragItem): GenImageItem => ({
      // Placeholder id; the store rewrites it to tslot-<tpl>-<media> on insert.
      id: `tpl-drop-${d.mediaId}`,
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

  // Route the drop: onto a template card -> append; onto blank area -> new one.
  useEffect(() => {
    const unsub = subscribeDrop((payload, x, y) => {
      const rect = panelRef.current?.getBoundingClientRect();
      if (!rect) return;
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
      const items = payloadToItems(payload);
      if (items.length === 0) return;
      const targetId = templateIdAtPoint(x, y);
      if (targetId) {
        items.forEach((it) => addImageToTemplate(targetId, it));
      } else {
        const [first, ...rest] = items;
        const newId = newTemplateWithImage(first);
        rest.forEach((it) => addImageToTemplate(newId, it));
      }
    });
    return unsub;
  }, [subscribeDrop, payloadToItems, addImageToTemplate, newTemplateWithImage]);

  return (
    <div className="flex flex-col h-full w-full bg-[#252525] rounded-sm overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#3D3D3D] shrink-0">
        <span className="text-[13px] text-[#8A8A8A] font-medium">模板</span>
        <button
          onClick={addTemplate}
          className="flex items-center gap-1 px-3 h-8 bg-[#2EC4B6] text-white text-[12px] rounded-lg hover:bg-[#25A99C] transition-colors cursor-pointer"
        >
          <Plus size={12} strokeWidth={2.5} />
          <span>添加模板</span>
        </button>
      </div>

      <div
        ref={panelRef}
        className={`scrollbar-dark flex-1 overflow-y-auto overflow-x-hidden p-3 space-y-2 transition-colors duration-200 ${
          frameOver && !dropTarget ? 'bg-[#2EC4B6]/5' : ''
        }`}
      >
        {templates.length === 0 ? (
          <div
            className={`flex flex-col items-center justify-center h-full gap-3 select-none transition-colors ${
              frameOver ? 'text-[#2EC4B6]' : 'text-[#555555]'
            }`}
          >
            <LayoutTemplate size={32} strokeWidth={1.5} />
            <span className="text-[13px]">
              点击“添加模板”，或拖动素材到此处新建模板
            </span>
          </div>
        ) : (
          <>
            {templates.map((t) => (
              <div key={t.id} data-template-id={t.id} className="min-w-0">
                <ClipNoteCard
                  images={t.images}
                  cardId={t.id}
                  note={t.content}
                  dragOver={dropTarget === t.id}
                  imageColClassName="w-[180px]"
                  textColClassName="flex-1"
                  copyTitle={t.includeTitle ? t.name : undefined}
                  enableRoleEntity
                  getImagePools={imagePools}
                  onPick={(item) => addImageToTemplate(t.id, item)}
                  header={
                    <TemplateHeader
                      name={t.name}
                      referenceable={t.referenceable}
                      includeTitle={t.includeTitle}
                      onHandlePointerDown={(e) =>
                        startCardReorder(e, templates.findIndex((x) => x.id === t.id))
                      }
                      onRename={(name) => renameTemplate(t.id, name)}
                      onToggleReferenceable={() =>
                        setReferenceable(t.id, !t.referenceable)
                      }
                      onToggleIncludeTitle={() =>
                        setIncludeTitle(t.id, !t.includeTitle)
                      }
                      onDuplicate={() => duplicateTemplate(t.id)}
                      onDelete={() => deleteTemplate(t.id)}
                    />
                  }
                  onReorder={(from, to) => reorderInTemplate(t.id, from, to)}
                  onDeleteImage={(slotId) => deleteImageFromTemplate(t.id, slotId)}
                  onNoteChange={(json) => setContent(t.id, json)}
                />
              </div>
            ))}
            {/* Always-present drop zone so a new template can be created even
                when existing cards overflow the panel. Not a data-template-id
                element, so a drop here routes to newTemplateWithImage. */}
            <div
              className={`shrink-0 min-h-[72px] flex items-center justify-center rounded-md border border-dashed text-[12px] select-none transition-colors ${
                frameOver && !dropTarget
                  ? 'border-[#2EC4B6] text-[#2EC4B6] bg-[#2EC4B6]/5'
                  : 'border-[#3D3D3D] text-[#555555]'
              }`}
            >
              拖动素材到此处新建模板
            </div>
          </>
        )}
      </div>
    </div>
  );
}

interface HeaderProps {
  name: string;
  referenceable: boolean;
  includeTitle: boolean;
  onHandlePointerDown?: (e: React.PointerEvent) => void;
  onRename: (name: string) => void;
  onToggleReferenceable: () => void;
  onToggleIncludeTitle: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

// The card's full-width top bar: template name (double-click / pencil to rename)
// two orthogonal toggle icons, and a delete button. Passed to ClipNoteCard as
// its `header`. 👁 referenceable = whether this template appears as an @template
// candidate in the Block area; # includeTitle = whether this template's own copy
// prepends `# name`.
function TemplateHeader({
  name,
  referenceable,
  includeTitle,
  onHandlePointerDown,
  onRename,
  onToggleReferenceable,
  onToggleIncludeTitle,
  onDuplicate,
  onDelete,
}: HeaderProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setValue(name);
  }, [name, editing]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const confirm = useCallback(
    (next: string) => {
      setEditing(false);
      const trimmed = next.trim();
      if (trimmed) onRename(trimmed);
    },
    [onRename]
  );

  return (
    <div className="group/tpl flex items-center justify-between px-2.5 py-1.5 border-b border-[#3D3D3D]">
      <div className="flex items-center gap-1 min-w-0 flex-1">
        {onHandlePointerDown && !editing && (
          <span
            onPointerDown={onHandlePointerDown}
            className="shrink-0 cursor-grab active:cursor-grabbing select-none opacity-0 group-hover/card:opacity-100 transition-opacity"
            title="拖动排序"
          >
            <GripVertical size={12} className="text-[#555555]" />
          </span>
        )}
        {editing ? (
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirm(value);
              if (e.key === 'Escape') setEditing(false);
            }}
            onBlur={() => confirm(value)}
            className="flex-1 min-w-0 bg-[#1E1E1E] text-[#E5E5E5] text-[12px] px-1.5 py-0.5 rounded outline-none ring-1 ring-[#2EC4B6]"
          />
        ) : (
          <div
            className="group/name flex items-center gap-1 min-w-0 cursor-pointer"
            data-no-collapse
            onDoubleClick={() => setEditing(true)}
            title="双击重命名"
          >
            <span className="text-[12px] text-[#E5E5E5] font-medium truncate">
              {name}
            </span>
            <Pencil
              size={10}
              className="text-[#666666] opacity-0 group-hover/name:opacity-100 transition-opacity shrink-0 hover:text-[#2EC4B6]"
              onClick={(e) => {
                e.stopPropagation();
                setEditing(true);
              }}
            />
          </div>
        )}
      </div>
        <div className="flex items-center gap-0.5 shrink-0">
        <button
          className={`p-0.5 rounded transition-all hover:bg-[#444444] ${
            referenceable ? 'text-[#2EC4B6]' : 'text-[#555555] hover:text-[#8A8A8A]'
          }`}
          onClick={onToggleReferenceable}
          title={referenceable ? '可被分镜区 @ 引用（点击关闭）' : '不可被分镜区 @ 引用（点击开启）'}
        >
          {referenceable ? <Eye size={11} /> : <EyeOff size={11} />}
        </button>
        <button
          className={`p-0.5 rounded transition-all hover:bg-[#444444] ${
            includeTitle ? 'text-[#2EC4B6]' : 'text-[#555555] hover:text-[#8A8A8A]'
          }`}
          onClick={onToggleIncludeTitle}
          title={includeTitle ? '复制时带 # 标题（点击关闭）' : '复制时不带标题（点击开启）'}
        >
          <Hash size={11} />
        </button>
        <button
          className="p-0.5 rounded text-[#555555] hover:text-[#2EC4B6] hover:bg-[#444444] transition-all opacity-0 group-hover/tpl:opacity-100"
          onClick={onDuplicate}
          title="复制此模板"
        >
          <Copy size={11} />
        </button>
        <button
          className="p-0.5 rounded text-[#555555] hover:text-red-400 hover:bg-[#444444] transition-all opacity-0 group-hover/tpl:opacity-100"
          onClick={onDelete}
          title="删除此模板"
        >
          <Trash2 size={11} />
        </button>
      </div>
    </div>
  );
}
