import { useEditor, EditorContent } from '@tiptap/react';
import type { Editor, JSONContent } from '@tiptap/react';
import type { Node } from '@tiptap/pm/model';
import { Fragment, Slice } from '@tiptap/pm/model';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { UndoRedo } from '@tiptap/extensions';
import { useImperativeHandle, forwardRef, useRef, useMemo } from 'react';
import { MentionAtom } from './MentionAtom';
import { createMentionSuggestion } from './mentionSuggestion';
import type { TemplateCandidate } from './mentionSuggestion';
import { RoleEntityAtom } from './RoleEntityAtom';
import { TemplateRefAtom } from './TemplateRefAtom';
import { TemplateRefContext } from './TemplateRefContext';
import { composeTemplateBlock } from './roleUtils';
import type { GenImageItem } from '../../context/GenImagesContext';
import { baseName } from '../../context/GenImagesContext';
import type { ChipMode } from '../../context/GenSettingsContext';

// Resolves an @template reference (in a block) to its serialized expansion per
// the 展开与续接规范:
//  - `lines`: `# 模板名` header (when the target's Phase 1 title rule allows)
//    followed by the kept content lines (checked-role lines + plain-text lines,
//    with `mention` resolved to Image{n}/baseName against THIS BLOCK's image
//    list). Unchecked-role lines are already dropped.
//  - `trailingBlank`: whether the template content ends with empty paragraph(s)
//    — a SIGNAL that forces the block's 后文 onto a new paragraph (Rule 2).
// Returns null when the target template no longer exists.
export interface ResolvedTemplateRef {
  lines: string[];
  trailingBlank: boolean;
}

export interface GenPromptEditorHandle {
  // Serialize the prompt to plain text, resolving every chip to its current
  // skin (Image{ordinal} or baseName) per the given mode. Missing slots -> ''.
  getPlainText: (images: GenImageItem[], mode: ChipMode) => string;
}

interface Props {
  getImages: () => GenImageItem[];
  getChipMode: () => ChipMode;
  // Optional: pool shown in the @ popup (defaults to getImages). Templates pass
  // the whole project library so any image can be @-referenced.
  getCandidates?: () => GenImageItem[];
  // Optional: named image pools rendered as @ tabs (e.g. 项目 / 全局). When set
  // (non-empty) they replace the single getCandidates pool; the picker shows one
  // tab per pool. Left unset by the gen area (single, tab-less pool).
  getImagePools?: () => {
    key: string;
    label: string;
    getItems: () => GenImageItem[];
  }[];
  // Optional: called when a candidate is picked, so the host can backfill its
  // left image list before the chip resolves. May return the resolved left-list
  // item, whose id becomes the chip's slotId.
  onPick?: (item: GenImageItem) => GenImageItem | void;
  // Initial note content (Tiptap JSON) when hydrating a saved cell.
  initialContent?: JSONContent | null;
  // Enable the `- name：` -> role-entity InputRule and register the roleEntity
  // node. Templates set this; the gen area leaves it off so its note behavior
  // is unchanged.
  enableRoleEntity?: boolean;
  // Enable @template references (Block area). Registers the templateRef node,
  // and feeds the @ popup a 【模板】 tab (gated by isCombine).
  enableTemplateRef?: boolean;
  // Live referenceable-template candidates for the @ 【模板】 tab (Block area).
  getTemplateCandidates?: () => TemplateCandidate[];
  // Whether combine mode is on for this container (Block area). When true, the
  // @ popup shows the 图片/模板 dual tabs.
  isCombine?: () => boolean;
  // Resolve an @template reference for copy/serialize (Block area).
  resolveTemplateRef?: (
    templateId: string,
    selectedRoleIds: string[],
    blockImages: GenImageItem[],
    mode: ChipMode
  ) => ResolvedTemplateRef | null;
  // Called when a role checkbox inside a templateRef is turned ON, so the host
  // can pull that role's bound image into the block's left list (Block area).
  onRoleChecked?: (templateId: string, roleId: string) => void;
  // Emitted whenever the note changes, so the store can persist it.
  onChange?: (json: JSONContent) => void;
}

// Walk the ProseMirror doc and serialize to plain text per the 展开与续接规范.
//
// For each block paragraph P (left to right):
//  - No @template node: text verbatim, roleEntity -> name, mention -> Image{n}
//    (code) / baseName (name) against the block's image list; one output line.
//  - With a @template node T (≤1 per paragraph):
//      1. 前文 (text before T in the same paragraph): if it has any
//         non-whitespace char it is FORCED onto its own line (so `# 标题`
//         always starts a line).
//      2. 展开块 = resolveTemplateRef(...).lines (already includes `# 模板名`
//         and the kept/filtered content lines).
//      3. 后文 (text after T in the same paragraph) continuation:
//           * Rule 1: 后文 non-empty AND !trailingBlank -> append 后文 to the
//             LAST expansion line with a single space.
//           * Rule 2: 后文 empty OR trailingBlank -> 后文 (and the following
//             paragraphs) start a NEW paragraph.
//      4. A trailing empty paragraph in the template is a SIGNAL only
//         (trailingBlank); it never renders as a blank line.
//  - Target template deleted (resolveTemplateRef -> null): treat T as absent,
//    merge 前文 + 后文 into one normal line.
function serialize(
  editor: Editor,
  images: GenImageItem[],
  mode: ChipMode,
  resolveTemplateRef?: (
    templateId: string,
    selectedRoleIds: string[],
    blockImages: GenImageItem[],
    mode: ChipMode
  ) => ResolvedTemplateRef | null
): string {
  const out: string[] = [];

  // Serialize a plain inline run (text / roleEntity / mention) to a string.
  // A roleEntity carries an implied leading `- ` (the dash the editor hides)
  // and is followed by a colon text node that is normalized to `: ` on copy.
  const renderInline = (nodes: Node[]): string => {
    let s = '';
    let afterRole = false;
    for (const child of nodes) {
      if (child.type.name === 'mention') {
        const slotId = child.attrs.slotId as string;
        const name = (child.attrs.name as string) ?? '';
        const idx = images.findIndex((it) => it.id === slotId);
        afterRole = false;
        if (idx < 0) continue; // slot removed -> drop the reference
        s += mode === 'code' ? `Image${idx + 1}` : baseName(name);
      } else if (child.type.name === 'roleEntity') {
        s += `- ${(child.attrs.name as string) ?? ''}`;
        afterRole = true;
      } else if (child.isText) {
        let t = child.text ?? '';
        // The colon right after a role -> normalize to `: ` (english + space).
        if (afterRole) t = t.replace(/^\s*[：:]\s*/, ': ');
        s += t;
        afterRole = false;
      } else {
        afterRole = false;
      }
    }
    return s;
  };

  editor.state.doc.forEach((block) => {
    // Split the paragraph's children around the (at most one) templateRef.
    const children: Node[] = [];
    block.forEach((c) => children.push(c));
    const tIdx = children.findIndex((c) => c.type.name === 'templateRef');

    if (tIdx < 0) {
      // No @template: a plain line (may be empty).
      out.push(renderInline(children));
      return;
    }

    const tNode = children[tIdx];
    const templateId = tNode.attrs.templateId as string;
    const selectedRoleIds = (tNode.attrs.selectedRoleIds as string[]) ?? [];
    const resolved = resolveTemplateRef?.(
      templateId,
      selectedRoleIds,
      images,
      mode
    );

    const before = renderInline(children.slice(0, tIdx));
    // Text auto-inserts a leading space after an inline atom; trim it so the
    // 后文 reads `零走到大街上`, not ` 零走到大街上`.
    const after = renderInline(children.slice(tIdx + 1)).replace(/^[ \t]+/, '');

    if (!resolved) {
      // Template gone: T is absent, merge 前文 + 后文 into one line.
      out.push((before + after).replace(/^[ \t]+|[ \t]+$/g, ''));
      return;
    }

    // 前文 own-line -> 展开块 -> 后文 Rule 1/2 (shared pure helper).
    out.push(
      ...composeTemplateBlock(
        before,
        resolved.lines,
        resolved.trailingBlank,
        after
      )
    );
  });

  return out.join('\n');
}

const GenPromptEditor = forwardRef<GenPromptEditorHandle, Props>(
  (
    {
      getImages,
      getChipMode,
      getCandidates,
      getImagePools,
      onPick,
      initialContent,
      enableRoleEntity,
      enableTemplateRef,
      getTemplateCandidates,
      isCombine,
      resolveTemplateRef,
      onRoleChecked,
      onChange,
    },
    ref
  ) => {
    // Keep latest getters in refs so the suggestion config (built once) always
    // reads fresh data without recreating the editor.
    const getImagesRef = useRef(getImages);
    const getChipModeRef = useRef(getChipMode);
    getImagesRef.current = getImages;
    getChipModeRef.current = getChipMode;
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
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
    const resolveTemplateRefRef = useRef(resolveTemplateRef);
    resolveTemplateRefRef.current = resolveTemplateRef;
    const onRoleCheckedRef = useRef(onRoleChecked);
    onRoleCheckedRef.current = onRoleChecked;

    const editor = useEditor({
      extensions: [
        Document,
        Paragraph,
        Text,
        // Tiptap v3 renamed History -> UndoRedo (now in @tiptap/extensions).
        // Gives each card's note its own local text undo/redo. Structural
        // changes (add/delete/reorder/duplicate cards) are handled by the
        // app-level HistoryContext timeline instead.
        UndoRedo,
        ...(enableRoleEntity ? [RoleEntityAtom] : []),
        ...(enableTemplateRef ? [TemplateRefAtom] : []),
        MentionAtom.configure({
          suggestion: createMentionSuggestion({
            getImages: () => getImagesRef.current(),
            getChipMode: () => getChipModeRef.current(),
            getCandidates: getCandidates
              ? () => (getCandidatesRef.current ?? getImagesRef.current)()
              : undefined,
            getImagePools: getImagePools
              ? () => getImagePoolsRef.current?.() ?? []
              : undefined,
            onPick: onPick ? (item) => onPickRef.current?.(item) : undefined,
            getTemplateCandidates: enableTemplateRef
              ? () => getTemplateCandidatesRef.current?.() ?? []
              : undefined,
            isCombine: enableTemplateRef
              ? () => isCombineRef.current?.() ?? false
              : undefined,
          }),
        }),
      ],
      content: initialContent ?? '',
      onUpdate: ({ editor }) => {
        onChangeRef.current?.(editor.getJSON());
      },
      editorProps: {
        attributes: {
          class:
            'gen-prompt-editor outline-none text-[13px] leading-relaxed text-[#E5E5E5] min-h-full',
        },
        // 从飞书等外部富文本源粘贴时，其 HTML 把所有行塞进单个
        // `<div style="white-space:pre">` 里、用行内 `\n` 表示换行，
        // ProseMirror 解析 HTML 时会把这种单容器内的换行折叠掉 → 换行丢失。
        // 但剪贴板里同时带一份保留换行的 text/plain。这里对“外部纯文本粘贴”
        // 走 text/plain 按行重建为多个 paragraph；应用内部复制（HTML 带
        // ProseMirror 的 data-pm-slice 标记）继续走默认逻辑，chip 等不受影响。
        handlePaste: (view, event) => {
          const data = event.clipboardData;
          if (!data) return false;
          const html = data.getData('text/html');
          // 内部复制：ProseMirror 会写入 data-pm-slice，交给默认处理以保留 chip。
          if (html && html.includes('data-pm-slice')) return false;
          const text = data.getData('text/plain');
          // 没有多行文本时交给默认逻辑（单行文本、纯 chip 粘贴等）。
          if (!text || !text.includes('\n')) return false;
          const { schema } = view.state;
          const paragraph = schema.nodes.paragraph;
          if (!paragraph) return false;
          const lines = text.replace(/\r\n?/g, '\n').split('\n');
          const paragraphs = lines.map((line) =>
            paragraph.create(
              null,
              line ? schema.text(line) : undefined
            )
          );
          const slice = new Slice(Fragment.from(paragraphs), 1, 1);
          view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
          return true;
        },
      },
    });

    useImperativeHandle(
      ref,
      () => ({
        getPlainText: (images, mode) =>
          editor
            ? serialize(editor, images, mode, (tid, ids, blkImgs, m) =>
                resolveTemplateRefRef.current?.(tid, ids, blkImgs, m) ?? null
              )
            : '',
      }),
      [editor]
    );

    // Bridge so a templateRef NodeView can pull a role's bound image into the
    // host block when its checkbox is turned on. Stable identity via useMemo.
    const bridge = useMemo(
      () => ({
        onRoleChecked: (templateId: string, roleId: string) =>
          onRoleCheckedRef.current?.(templateId, roleId),
      }),
      []
    );

    return (
      <TemplateRefContext.Provider value={bridge}>
        <EditorContent
          editor={editor}
          className="scrollbar-dark flex-1 overflow-y-auto px-3 py-2"
        />
      </TemplateRefContext.Provider>
    );
  }
);

GenPromptEditor.displayName = 'GenPromptEditor';

export default GenPromptEditor;
