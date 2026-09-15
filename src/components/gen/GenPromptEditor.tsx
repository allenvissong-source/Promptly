import { useEditor, EditorContent } from '@tiptap/react';
import type { Editor, JSONContent } from '@tiptap/react';
import type { Node } from '@tiptap/pm/model';
import { Fragment, Slice } from '@tiptap/pm/model';
import { DOMParser as PMDOMParser } from '@tiptap/pm/model';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import Bold from '@tiptap/extension-bold';
import { TextStyle, Color, BackgroundColor } from '@tiptap/extension-text-style';
import Italic from '@tiptap/extension-italic';
import Underline from '@tiptap/extension-underline';
import Strike from '@tiptap/extension-strike';
import TextAlign from '@tiptap/extension-text-align';
import { UndoRedo } from '@tiptap/extensions';
import {
  useImperativeHandle,
  forwardRef,
  useRef,
  useMemo,
  useEffect,
} from 'react';
import { useActiveEditor } from '../../context/ActiveEditorContext';
import { MentionAtom } from './MentionAtom';
import { createMentionSuggestion } from './mentionSuggestion';
import type { TemplateCandidate } from './mentionSuggestion';
import { RoleEntityAtom } from './RoleEntityAtom';
import { TemplateRefAtom } from './TemplateRefAtom';
import { TemplateRefContext } from './TemplateRefContext';
import { SearchReplace } from './SearchReplace';
import { composeTemplateBlock, type StyledLine } from './roleUtils';
import type { GenImageItem } from '../../context/GenImagesContext';
import { baseName } from '../../context/GenImagesContext';
import type { ChipMode } from '../../context/GenSettingsContext';
import { EMPTY_STYLE, type CharacterStyle } from '../../lib/richClipboard';

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
  lines: StyledLine[];
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
  const out: StyledLine[] = [];

  // Convert ProseMirror marks to CharacterStyle
  const marksToStyle = (marks: readonly { type: { name: string }; attrs: Record<string, any> }[]): CharacterStyle => {
    const style = { ...EMPTY_STYLE };
    for (const mark of marks) {
      switch (mark.type.name) {
        case 'bold':
          style.bold = true;
          break;
        case 'italic':
          style.italic = true;
          break;
        case 'underline':
          style.underline = true;
          break;
        case 'strike':
          style.strike = true;
          break;
        case 'textStyle':
          if (mark.attrs.color) style.textColor = mark.attrs.color;
          if (mark.attrs.backgroundColor) style.backgroundColor = mark.attrs.backgroundColor;
          break;
      }
    }
    return style;
  };

  // Append styled text to output
  const appendStyled = (text: string, style: CharacterStyle, outText: string[], outStyles: CharacterStyle[]) => {
    outText.push(text);
    for (let i = 0; i < text.length; i++) {
      outStyles.push({ ...style });
    }
  };

  // Trim leading whitespace from styled line
  const trimLeading = (line: StyledLine): StyledLine => {
    let start = 0;
    while (start < line.text.length && /[ \t]/.test(line.text[start])) {
      start++;
    }
    if (start === 0) return line;
    return {
      text: line.text.slice(start),
      styles: line.styles.slice(start),
    };
  };

  // Serialize a plain inline run (text / roleEntity / mention) to a styled line.
  // A roleEntity carries an implied leading `- ` (the dash the editor hides)
  // and is followed by a colon text node that is normalized to `: ` on copy.
  const renderInline = (nodes: Node[]): StyledLine => {
    const lineText: string[] = [];
    const lineStyles: CharacterStyle[] = [];
    let afterRole = false;
    for (const child of nodes) {
      if (child.type.name === 'mention') {
        const slotId = child.attrs.slotId as string;
        const name = (child.attrs.name as string) ?? '';
        const idx = images.findIndex((it) => it.id === slotId);
        afterRole = false;
        if (idx < 0) continue; // slot removed -> drop the reference
        const mentionText = mode === 'code' ? `Image${idx + 1}` : baseName(name);
        const style = marksToStyle(child.marks);
        appendStyled(mentionText, style, lineText, lineStyles);
      } else if (child.type.name === 'roleEntity') {
        const roleText = `- ${(child.attrs.name as string) ?? ''}`;
        const style = marksToStyle(child.marks);
        appendStyled(roleText, style, lineText, lineStyles);
        afterRole = true;
      } else if (child.isText) {
        let t = child.text ?? '';
        // The colon right after a role -> normalize to `: ` (english + space).
        if (afterRole) t = t.replace(/^\s*[：:]\s*/, ': ');
        const style = marksToStyle(child.marks);
        appendStyled(t, style, lineText, lineStyles);
        afterRole = false;
      } else {
        afterRole = false;
      }
    }
    return {
      text: lineText.join(''),
      styles: lineStyles,
    };
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
    const after = trimLeading(renderInline(children.slice(tIdx + 1)));

    if (!resolved) {
      // Template gone: T is absent, merge 前文 + 后文 into one line.
      const merged = {
        text: before.text + after.text,
        styles: [...before.styles, ...after.styles],
      };
      // Trim both ends
      let start = 0;
      while (start < merged.text.length && /[ \t]/.test(merged.text[start])) start++;
      let end = merged.text.length;
      while (end > 0 && /[ \t]/.test(merged.text[end - 1])) end--;
      out.push({
        text: merged.text.slice(start, end),
        styles: merged.styles.slice(start, end),
      });
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

  return out.map(l => l.text).join('\n');
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

    // 把本卡片编辑器接入全局「当前活动编辑器」，供顶部格式工具条操作。
    const { setActiveEditor, clearIfActive, bumpVersion } = useActiveEditor();

    const editor = useEditor({
      extensions: [
        Document,
        Paragraph,
        Text,
        // 富文本着色/加粗：粘贴自飞书等外部源的 color / background-color /
        // font-weight 会被这些 mark 保留并渲染。TextStyle 是 Color/
        // BackgroundColor 依附的载体 mark，必须一并注册。
        Bold,
        Italic,
        Underline,
        Strike,
        TextStyle,
        Color,
        BackgroundColor,
        // 段落对齐（左/中/右）。只作用于 paragraph（本编辑器无 heading）。
        TextAlign.configure({ types: ['paragraph'] }),
        // Tiptap v3 renamed History -> UndoRedo (now in @tiptap/extensions).
        // Gives each card's note its own local text undo/redo. Structural
        // changes (add/delete/reorder/duplicate cards) are handled by the
        // app-level HistoryContext timeline instead.
        UndoRedo,
        // Ctrl+F / Ctrl+H 的查找替换：命中高亮 + 跳转 + 替换命令，由顶层
        // FindReplaceBar 通过「当前活动编辑器」驱动。不注册任何快捷键，
        // 避免与既有 Ctrl+S / Ctrl+Z 等全局键位冲突。
        SearchReplace,
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
      onFocus: ({ editor }) => {
        setActiveEditor(editor);
      },
      // 选区/内容变化时刷新工具条按钮的激活态（仅当自己是活动编辑器）。
      onSelectionUpdate: () => {
        bumpVersion();
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
          const { schema } = view.state;
          const paragraph = schema.nodes.paragraph;
          if (!paragraph) return false;

          // 外部富文本粘贴（飞书等）：用 ProseMirror DOMParser 解析 HTML，
          // 已注册的 Bold/Italic/Underline/Strike/Color/BackgroundColor mark
          // 会据其 parseHTML 规则把 font-weight / color / background-color 转成
          // mark 保留下来；未注册的 font-size 会被自动丢弃（符合“不保留字号”）。
          // 飞书把整段塞进单个 white-space:pre 容器、用行内 \n 表示换行，直接解析
          // 会把换行折叠掉，故用 preserveWhitespace:'full' 保留 \n，再按 \n 把每个
          // textblock 拆成多个 paragraph（拆分时沿用各文本片段的 marks）。
          if (html && html.trim()) {
            try {
              const doc = document.implementation.createHTMLDocument('');
              doc.body.innerHTML = html;
              const parsed = PMDOMParser.fromSchema(schema).parse(doc.body, {
                preserveWhitespace: 'full',
              });
              const paragraphs: Node[] = [];
              parsed.descendants((node) => {
                if (!node.isTextblock) return true;
                let line: Node[] = [];
                const pushLine = () => {
                  paragraphs.push(
                    paragraph.create(
                      null,
                      line.length ? Fragment.from(line) : undefined
                    )
                  );
                  line = [];
                };
                node.content.forEach((inline) => {
                  if (inline.isText) {
                    const segs = (inline.text ?? '').split('\n');
                    segs.forEach((seg, i) => {
                      if (i > 0) pushLine();
                      if (seg) line.push(schema.text(seg, inline.marks));
                    });
                  } else {
                    line.push(inline);
                  }
                });
                pushLine();
                return false; // 不再深入 textblock 内部
              });
              if (paragraphs.length) {
                const slice = new Slice(Fragment.from(paragraphs), 1, 1);
                view.dispatch(
                  view.state.tr.replaceSelection(slice).scrollIntoView()
                );
                return true;
              }
            } catch {
              // 解析失败则退回纯文本逻辑。
            }
          }

          // 无 HTML 的纯文本多行粘贴：按行重建为多个 paragraph。
          const text = data.getData('text/plain');
          if (!text || !text.includes('\n')) return false;
          const lines = text.replace(/\r\n?/g, '\n').split('\n');
          const paragraphs = lines.map((line) =>
            paragraph.create(null, line ? schema.text(line) : undefined)
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

    // 卸载（或换成另一个 editor 实例）时，若本卡片仍是全局活动编辑器则清空，
    // 避免顶部工具条持有已销毁的 editor 引用。clearIfActive 只在“确是当前活动
    // 编辑器”时才清空，不会误伤刚获得焦点的其他卡片。
    useEffect(() => {
      return () => {
        if (editor) clearIfActive(editor);
      };
    }, [editor, clearIfActive]);

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
