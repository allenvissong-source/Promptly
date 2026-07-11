import { useState, useRef, useCallback, type ReactNode } from 'react';
import type { JSONContent } from '@tiptap/react';
import { invoke } from '@tauri-apps/api/core';
import {
  GripVertical,
  Image,
  Music,
  Video,
  Trash2,
  Copy,
  Check,
  Images,
} from 'lucide-react';
import {
  GenImagesProvider,
  type GenImageItem,
} from '../../context/GenImagesContext';
import { useGenSettings } from '../../context/GenSettingsContext';
import type { ChipMode } from '../../context/GenSettingsContext';
import GenPromptEditor, { type GenPromptEditorHandle } from './GenPromptEditor';
import type { ResolvedTemplateRef } from './GenPromptEditor';
import type { TemplateCandidate } from './mentionSuggestion';
import { isCardCollapsed, setCardCollapsed } from '../../lib/collapse';

interface Props {
  // The ordered LEFT image list. This is BOTH the GenImages scope (chips
  // resolve against it) and the ordinal source (Image1/2/3 = position here).
  images: GenImageItem[];
  note: JSONContent | null;
  dragOver: boolean;

  // Column width classes. Gen area: wide image / narrow note (defaults).
  // Templates: fixed 180px image / wide note (text is the main body).
  imageColClassName?: string;
  textColClassName?: string;

  // Optional full-width header bar above the two columns (templates use it for
  // name + rename + delete). Gen cells leave it undefined.
  header?: ReactNode;
  // Optional mini header inside the note (right) column (gen cells use it for
  // the "备注" label + delete-cell button). Templates leave it undefined.
  noteHeader?: ReactNode;

  // Optional @ popup pool + backfill. When getCandidates is set, the popup
  // draws from it (e.g. the whole project library) and onPick backfills the
  // left list. When both are undefined the popup pool is the left list itself
  // (gen-area behavior).
  getCandidates?: () => GenImageItem[];
  onPick?: (item: GenImageItem) => GenImageItem | void;

  // Optional: named image pools rendered as @ tabs (e.g. 项目 / 全局). When set,
  // replaces the single getCandidates pool with one tab per pool. onPick still
  // handles backfill for picks from any pool.
  getImagePools?: () => {
    key: string;
    label: string;
    getItems: () => GenImageItem[];
  }[];

  // Copy buttons (both default on).
  showCopyImages?: boolean;
  showCopyText?: boolean;

  // When set, the right-side "复制" (copy text) button prepends `# ${copyTitle}\n`
  // to the copied plain text (template cards pass their name here). The gen area
  // leaves it undefined so its copy behavior is unchanged.
  copyTitle?: string;

  // Enable the `- name：` role-entity InputRule in this card's editor. Templates
  // (and blocks) set this; the gen area leaves it off.
  enableRoleEntity?: boolean;

  // Block area only: enable @template references (dual-tab @ picker + inline
  // role checkboxes). The gen area and templates leave these off.
  enableTemplateRef?: boolean;
  getTemplateCandidates?: () => TemplateCandidate[];
  isCombine?: () => boolean;
  resolveTemplateRef?: (
    templateId: string,
    selectedRoleIds: string[],
    blockImages: GenImageItem[],
    mode: ChipMode
  ) => ResolvedTemplateRef | null;
  onRoleChecked?: (templateId: string, roleId: string) => void;

  // Card-level collapse: double-clicking the header's blank area toggles a
  // fixed-height, scrollable collapsed view. Persisted locally by this id
  // (cell/tpl/blk id — stable across save/reload). Omitted = no collapse.
  cardId?: string;

  onReorder: (from: number, to: number) => void;
  onDeleteImage: (slotId: string) => void;
  onNoteChange: (json: JSONContent) => void;
}

// A dual-column card: a vertical list of clip rows on the left (drag handle +
// thumbnail + name + live ordinal + delete) and an @-mention note on the right.
// Ordinals and chip labels resolve against `images`, which is also this card's
// GenImages scope. Shared by the gen area (wide image / narrow note) and the
// template area (fixed image / wide note); the differences are all props.
export default function ClipNoteCard({
  images,
  note,
  dragOver,
  imageColClassName = 'flex-1',
  textColClassName = 'w-[160px]',
  header,
  noteHeader,
  getCandidates,
  onPick,
  getImagePools,
  showCopyImages = true,
  showCopyText = true,
  copyTitle,
  enableRoleEntity,
  enableTemplateRef,
  getTemplateCandidates,
  isCombine,
  resolveTemplateRef,
  onRoleChecked,
  cardId,
  onReorder,
  onDeleteImage,
  onNoteChange,
}: Props) {
  const { chipMode } = useGenSettings();
  const [collapsed, setCollapsed] = useState(() =>
    cardId ? isCardCollapsed(cardId) : false
  );
  const toggleCollapse = useCallback(() => {
    if (!cardId) return;
    setCollapsed((c) => {
      const next = !c;
      setCardCollapsed(cardId, next);
      return next;
    });
  }, [cardId]);
  // 双击标题栏“空白处”折叠/展开；落在按钮/输入/带 data-no-collapse 的标题文字上时
  // 忽略，以保留原有交互（如模板双击标题=重命名）。
  const handleHeaderDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!cardId) return;
      const el = e.target as HTMLElement;
      if (el.closest('button, input, textarea, label, a, [data-no-collapse]'))
        return;
      toggleCollapse();
    },
    [cardId, toggleCollapse]
  );
  const listRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<GenPromptEditorHandle>(null);

  const imagesRef = useRef(images);
  imagesRef.current = images;
  const chipModeRef = useRef(chipMode);
  chipModeRef.current = chipMode;
  const copyTitleRef = useRef(copyTitle);
  copyTitleRef.current = copyTitle;
  const getCandidatesRef = useRef(getCandidates);
  getCandidatesRef.current = getCandidates;
  const getImagePoolsRef = useRef(getImagePools);
  getImagePoolsRef.current = getImagePools;
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const getTemplateCandidatesRef = useRef(getTemplateCandidates);
  getTemplateCandidatesRef.current = getTemplateCandidates;
  const isCombineRef = useRef(isCombine);
  isCombineRef.current = isCombine;

  // Pointer-based reorder within this card's row list.
  const reorderState = useRef<{ from: number } | null>(null);

  const indexAtPoint = useCallback((y: number): number => {
    const rows = listRef.current?.querySelectorAll('[data-row-index]');
    if (!rows) return 0;
    for (let i = 0; i < rows.length; i++) {
      const r = (rows[i] as HTMLElement).getBoundingClientRect();
      if (y < r.top + r.height / 2) return i;
    }
    return rows.length;
  }, []);

  const startReorder = (e: React.PointerEvent, index: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    reorderState.current = { from: index };

    const move = (ev: PointerEvent) => {
      const st = reorderState.current;
      if (!st) return;
      let to = indexAtPoint(ev.clientY);
      if (to > st.from) to -= 1;
      if (to === st.from || to < 0) return;
      onReorder(st.from, to);
      st.from = to;
    };
    const up = () => {
      reorderState.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const [copiedNote, setCopiedNote] = useState(false);
  const handleCopyText = async () => {
    const body =
      editorRef.current?.getPlainText(imagesRef.current, chipModeRef.current) ?? '';
    const title = copyTitleRef.current?.trim();
    const text =
      title && title !== '未命名模板' ? `# ${title}\n${body}` : body;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopiedNote(true);
    setTimeout(() => setCopiedNote(false), 1500);
  };

  // Copy every image in this card to the system clipboard as a native FILE LIST
  // (Windows CF_HDROP), so apps like QQ/WeChat can paste all of them at once.
  const [copiedImgs, setCopiedImgs] = useState(false);
  const handleCopyAllImages = async () => {
    const paths = imagesRef.current
      .filter((it) => it.type === 'image' && it.path)
      .map((it) => it.path);
    if (paths.length === 0) return;
    try {
      await invoke('copy_files_to_clipboard', { paths });
      setCopiedImgs(true);
      setTimeout(() => setCopiedImgs(false), 1500);
    } catch (err) {
      console.error('Copy images failed', err);
    }
  };

  const typeIcon = (type: GenImageItem['type']) => {
    if (type === 'audio') return <Music size={18} className="text-[#2EC4B6]" />;
    if (type === 'video') return <Video size={18} className="text-[#2EC4B6]" />;
    return <Image size={18} className="text-[#2EC4B6]" />;
  };

  return (
    <GenImagesProvider value={{ images }}>
      <div
        className={`group/card flex flex-col rounded-md border transition-all duration-200 overflow-hidden min-h-[80px] min-w-0 ${
          dragOver
            ? 'border-[#2EC4B6] bg-[#2EC4B6]/5'
            : 'border-[#3D3D3D] bg-[#252525]'
        }`}
      >
          {header ? (
            <div
              className="shrink-0"
              onDoubleClick={handleHeaderDoubleClick}
              title={cardId ? '双击标题栏空白处折叠/展开' : undefined}
            >
              {header}
            </div>
          ) : null}
          <div
            className={`flex flex-1 gap-2 min-w-0 ${
              collapsed ? 'max-h-[120px] overflow-y-auto scrollbar-dark' : ''
            }`}
        >
          {/* Left: clip rows + a footer to copy all of this card's images */}
          <div className={`flex flex-col min-w-0 ${imageColClassName}`}>
            <div ref={listRef} className="flex-1 flex flex-col gap-1.5 p-2 min-w-0">
              {images.map((item, index) => (
                <div
                  key={item.id}
                  data-row-index={index}
                  className="group/clip flex items-center gap-2.5 px-2.5 py-2 bg-[#252525] hover:bg-[#333333] rounded-md transition-colors"
                >
                  <div
                    onPointerDown={(e) => startReorder(e, index)}
                    className="shrink-0 cursor-grab active:cursor-grabbing select-none"
                    title="拖动排序"
                  >
                    <GripVertical size={14} className="text-[#555555]" />
                  </div>
                  <div className="w-[56px] h-[38px] rounded-md overflow-hidden bg-[#333333] flex items-center justify-center shrink-0">
                    {item.thumb ? (
                      <img
                        src={item.thumb}
                        alt={item.name}
                        className="w-full h-full object-cover pointer-events-none"
                      />
                    ) : (
                      typeIcon(item.type)
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] text-[#E5E5E5] truncate">{item.name}</div>
                    <div className="text-[11px] text-[#8A8A8A]">
                      <span className="text-[#2EC4B6]">Image{index + 1}</span>
                      {item.meta ? <span> · {item.meta}</span> : null}
                    </div>
                  </div>
                  <button
                    className="p-1 rounded text-[#555555] hover:text-red-400 hover:bg-[#444444] transition-all opacity-0 group-hover/clip:opacity-100 shrink-0"
                    onClick={() => onDeleteImage(item.id)}
                    title="移除"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
            {showCopyImages && images.length > 0 ? (
              <div className="flex justify-end px-2 pb-1.5">
                <button
                  className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-all cursor-pointer ${
                    copiedImgs
                      ? 'text-[#2EC4B6] bg-[#2EC4B6]/10'
                      : 'text-[#8A8A8A] hover:text-[#2EC4B6] hover:bg-[#333333]'
                  }`}
                  onClick={handleCopyAllImages}
                  title="复制此格子的全部图片"
                >
                  {copiedImgs ? (
                    <>
                      <Check size={10} />
                      <span>已复制</span>
                    </>
                  ) : (
                    <>
                      <Images size={10} />
                      <span>复制图片</span>
                    </>
                  )}
                </button>
              </div>
            ) : null}
          </div>

          {/* Right: this card's @ note box */}
          <div
            className={`border-l border-[#3D3D3D] flex flex-col shrink-0 min-w-0 ${textColClassName}`}
          >
            {noteHeader ? (
              // 生图卡片没有顶部 header，折叠由这里的“备注”栏双击触发。
              // 模板/分镜由顶部 header 触发，此处不额外绑定，避免重复。
                header ? (
                  noteHeader
                ) : (
                  <div
                    onDoubleClick={handleHeaderDoubleClick}
                    title={cardId ? '双击标题栏空白处折叠/展开' : undefined}
                  >
                    {noteHeader}
                  </div>
                )
            ) : null}
            <div className="flex-1 min-h-[64px] flex flex-col">
              <GenPromptEditor
                ref={editorRef}
                getImages={() => imagesRef.current}
                getChipMode={() => chipModeRef.current}
                getCandidates={
                  getCandidates
                    ? () => getCandidatesRef.current?.() ?? imagesRef.current
                    : undefined
                }
                getImagePools={
                  getImagePools
                    ? () => getImagePoolsRef.current?.() ?? []
                    : undefined
                }
                onPick={onPick ? (item) => onPickRef.current?.(item) : undefined}
                initialContent={note}
                enableRoleEntity={enableRoleEntity}
                enableTemplateRef={enableTemplateRef}
                getTemplateCandidates={
                  getTemplateCandidates
                    ? () => getTemplateCandidatesRef.current?.() ?? []
                    : undefined
                }
                isCombine={
                  isCombine ? () => isCombineRef.current?.() ?? false : undefined
                }
                resolveTemplateRef={resolveTemplateRef}
                onRoleChecked={onRoleChecked}
                onChange={onNoteChange}
              />
            </div>
            {showCopyText ? (
              <div className="flex justify-end px-2 pb-1.5">
                <button
                  className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-all cursor-pointer ${
                    copiedNote
                      ? 'text-[#2EC4B6] bg-[#2EC4B6]/10'
                      : 'text-[#8A8A8A] hover:text-[#2EC4B6] hover:bg-[#333333]'
                  }`}
                  onClick={handleCopyText}
                  title="复制备注内容"
                >
                  {copiedNote ? (
                    <>
                      <Check size={10} />
                      <span>已复制</span>
                    </>
                  ) : (
                    <>
                      <Copy size={10} />
                      <span>复制</span>
                    </>
                  )}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </GenImagesProvider>
  );
}
