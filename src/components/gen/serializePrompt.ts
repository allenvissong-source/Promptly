import type { JSONContent } from '@tiptap/react';
import { baseName, type GenImageItem } from '../../context/GenImagesContext';
import type { ChipMode } from '../../context/GenSettingsContext';
import { composeTemplateBlock, type StyledLine } from './roleUtils';
import type { ResolvedTemplateRef } from './GenPromptEditor';
import { EMPTY_STYLE, type CharacterStyle } from '../../lib/richClipboard';

// Convert Tiptap marks array to CharacterStyle
function marksToStyle(marks: JSONContent['marks']): CharacterStyle {
  const style = { ...EMPTY_STYLE };
  if (!marks) return style;
  for (const mark of marks) {
    switch (mark.type) {
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
        if (mark.attrs?.color) style.textColor = mark.attrs.color as string;
        if (mark.attrs?.backgroundColor) style.backgroundColor = mark.attrs.backgroundColor as string;
        break;
    }
  }
  return style;
}

// Append styled text to output text and styles array
function appendStyled(text: string, style: CharacterStyle, outText: string[], outStyles: CharacterStyle[]) {
  outText.push(text);
  for (let i = 0; i < text.length; i++) {
    outStyles.push({ ...style });
  }
}

// Pure JSONContent -> plain text serializer. Mirrors GenPromptEditor's live
// `serialize()` (which needs a mounted Editor) so the app-level "复制全部" (A5)
// can serialize every card WITHOUT a live editor per off-screen card:
//   - text node          -> its text verbatim
//   - roleEntity node     -> its name
//   - mention node        -> `Image{n}` (chipMode 'code') / baseName(name)
//                            ('name'), resolved against `images` by slotId;
//                            a slot no longer present is dropped
//   - one templateRef per paragraph -> expanded via resolveTemplateRef and
//     stitched by composeTemplateBlock (前文 own-line / 展开块 / 后文 Rule 1|2),
//     exactly matching the live serializer.
export interface SerializedPrompt {
  plainText: string;
  styles: CharacterStyle[];
}

export function serializePromptContent(
  content: JSONContent | null | undefined,
  images: GenImageItem[],
  mode: ChipMode,
  resolveTemplateRef?: (
    templateId: string,
    selectedRoleIds: string[],
    blockImages: GenImageItem[],
    mode: ChipMode
  ) => ResolvedTemplateRef | null
): SerializedPrompt {
  if (!content) return { plainText: '', styles: [] };
  const outLines: StyledLine[] = [];

  const renderInline = (nodes: JSONContent[]): StyledLine => {
    const lineText: string[] = [];
    const lineStyles: CharacterStyle[] = [];
    let afterRole = false;
    for (const child of nodes) {
      if (child.type === 'mention') {
        const slotId = child.attrs?.slotId as string | undefined;
        const name = (child.attrs?.name as string) ?? '';
        const idx = images.findIndex((it) => it.id === slotId);
        afterRole = false;
        if (idx < 0) continue; // slot removed -> drop the reference
        const mentionText = mode === 'code' ? `Image${idx + 1}` : baseName(name);
        const style = marksToStyle(child.marks);
        appendStyled(mentionText, style, lineText, lineStyles);
      } else if (child.type === 'roleEntity') {
        // Implied leading dash the editor hides.
        const roleText = `- ${(child.attrs?.name as string) ?? ''}`;
        const style = marksToStyle(child.marks);
        appendStyled(roleText, style, lineText, lineStyles);
        afterRole = true;
      } else if (child.type === 'text') {
        let t = child.text ?? '';
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

  // Helper to trim leading whitespace from a styled line
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

  // Helper to trim trailing whitespace from a styled line
  const trimTrailing = (line: StyledLine): StyledLine => {
    let end = line.text.length;
    while (end > 0 && /[ \t]/.test(line.text[end - 1])) {
      end--;
    }
    if (end === line.text.length) return line;
    return {
      text: line.text.slice(0, end),
      styles: line.styles.slice(0, end),
    };
  };

  // Helper to trim both ends
  const trimLine = (line: StyledLine): StyledLine => trimTrailing(trimLeading(line));

  // Helper to concatenate two styled lines
  const concatLines = (a: StyledLine, b: StyledLine): StyledLine => {
    return {
      text: a.text + b.text,
      styles: [...a.styles, ...b.styles],
    };
  };

  for (const block of content.content ?? []) {
    const children = block.content ?? [];
    const tIdx = children.findIndex((c) => c.type === 'templateRef');

    if (tIdx < 0) {
      // No @template: a plain line (may be empty).
      outLines.push(renderInline(children));
      continue;
    }

    const tNode = children[tIdx];
    const templateId = (tNode.attrs?.templateId as string) ?? '';
    const selectedRoleIds = (tNode.attrs?.selectedRoleIds as string[]) ?? [];
    const resolved = resolveTemplateRef?.(
      templateId,
      selectedRoleIds,
      images,
      mode
    );

    const before = renderInline(children.slice(0, tIdx));
    // Trim the auto-inserted leading space after the inline atom.
    const after = trimLeading(renderInline(children.slice(tIdx + 1)));

    if (!resolved) {
      // Template gone: merge 前文 + 后文 into one line.
      outLines.push(trimLine(concatLines(before, after)));
      continue;
    }

    outLines.push(
      ...composeTemplateBlock(
        before,
        resolved.lines,
        resolved.trailingBlank,
        after
      )
    );
  }

  // Join all lines with newlines
  if (outLines.length === 0) return { plainText: '', styles: [] };
  let plainText = outLines[0].text;
  let styles = [...outLines[0].styles];
  for (let i = 1; i < outLines.length; i++) {
    plainText += '\n';
    styles.push({ ...EMPTY_STYLE });
    plainText += outLines[i].text;
    styles.push(...outLines[i].styles);
  }

  return { plainText, styles };
}

// Merge every card across the 生图区 / 模板区 / 分镜区 into one plain-text blob
// (A5 "复制全部"), following the current chipMode. Cards are joined by a blank
// line; empty cards are skipped. Templates prepend `# name` when includeTitle
// is on and the name is a real (non-default) title — matching each template's
// own copy button. Blocks resolve @template refs via resolveTemplateRef.
export interface MergeCell {
  images: GenImageItem[];
  note: JSONContent | null;
}
export interface MergeTemplate {
  name: string;
  includeTitle: boolean;
  content: JSONContent | null;
  images: GenImageItem[];
}
export interface MergeBlock {
  content: JSONContent | null;
  images: GenImageItem[];
}

export function mergeAllPrompts(
  cells: MergeCell[],
  templates: MergeTemplate[],
  blocks: MergeBlock[],
  mode: ChipMode,
  resolveTemplateRef?: (
    templateId: string,
    selectedRoleIds: string[],
    blockImages: GenImageItem[],
    mode: ChipMode
  ) => ResolvedTemplateRef | null
): SerializedPrompt {
  const segments: SerializedPrompt[] = [];

  for (const cell of cells) {
    const body = serializePromptContent(cell.note, cell.images, mode);
    if (body.plainText.trim()) segments.push(body);
  }

  for (const t of templates) {
    const body = serializePromptContent(t.content, t.images, mode);
    const title = t.includeTitle ? t.name.trim() : '';
    if (title && title !== '未命名模板') {
      // Prepend `# 标题\n` with empty style
      const titleText = `# ${title}\n`;
      const titleStyles = Array.from({ length: titleText.length }, () => ({ ...EMPTY_STYLE }));
      segments.push({
        plainText: titleText + body.plainText,
        styles: [...titleStyles, ...body.styles],
      });
    } else {
      if (body.plainText.trim()) segments.push(body);
    }
  }

  for (const b of blocks) {
    const body = serializePromptContent(
      b.content,
      b.images,
      mode,
      resolveTemplateRef
    );
    if (body.plainText.trim()) segments.push(body);
  }

  if (segments.length === 0) return { plainText: '', styles: [] };
  // Join segments with \n\n
  let plainText = segments[0].plainText;
  let styles = [...segments[0].styles];
  for (let i = 1; i < segments.length; i++) {
    plainText += '\n\n';
    styles.push({ ...EMPTY_STYLE }, { ...EMPTY_STYLE });
    plainText += segments[i].plainText;
    styles.push(...segments[i].styles);
  }

  return { plainText, styles };
}
