import type { JSONContent } from '@tiptap/react';
import { baseName, type GenImageItem } from '../../context/GenImagesContext';
import type { ChipMode } from '../../context/GenSettingsContext';
import { EMPTY_STYLE, type CharacterStyle } from '../../lib/richClipboard';

export interface RoleRef {
  id: string;
  name: string;
}

// A line of text with per-character styles
export interface StyledLine {
  text: string;
  styles: CharacterStyle[];
}

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

// Helper to concatenate two styled lines
const concatLines = (a: StyledLine, b: StyledLine): StyledLine => {
  if (a.text.length === 0) return b;
  if (b.text.length === 0) return a;
  return {
    text: a.text + b.text,
    styles: [...a.styles, ...b.styles],
  };
};

// Trim trailing whitespace from a styled line
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

// Walk a Tiptap doc (content JSON) and collect every roleEntity node in
// document order. Used to enumerate a template's roles (for the Block area's
// @template checkboxes). Names are the live snapshot stored on each node.
export function rolesOf(content: JSONContent | null | undefined): RoleRef[] {
  const out: RoleRef[] = [];
  const visit = (node: JSONContent | undefined) => {
    if (!node) return;
    if (node.type === 'roleEntity') {
      const id = (node.attrs?.id as string) ?? '';
      const name = (node.attrs?.name as string) ?? '';
      if (id) out.push({ id, name });
    }
    node.content?.forEach(visit);
  };
  visit(content ?? undefined);
  return out;
}

// Light-scheme bound image: the image a role points at is the first image
// mention node living in the SAME paragraph as the role entity (e.g.
// `- 零：@Image1` binds 零 to that image). Resolves the mention's mediaId
// against the given slot list (a template's image list). Returns the matching
// slot item, or null when the role has no image or the media isn't in slots.
export function roleBoundImage(
  content: JSONContent | null | undefined,
  roleId: string,
  slots: GenImageItem[]
): GenImageItem | null {
  if (!content) return null;
  const paragraphs: JSONContent[] = [];
  const collectParagraphs = (node: JSONContent | undefined) => {
    if (!node) return;
    if (node.type === 'paragraph') paragraphs.push(node);
    node.content?.forEach(collectParagraphs);
  };
  collectParagraphs(content);

  for (const para of paragraphs) {
    const children = para.content ?? [];
    const hasRole = children.some(
      (c) => c.type === 'roleEntity' && (c.attrs?.id as string) === roleId
    );
    if (!hasRole) continue;
    const mention = children.find((c) => c.type === 'mention');
    if (!mention) return null;
    const mediaId = mention.attrs?.mediaId as number | undefined;
    if (mediaId == null) return null;
    return slots.find((s) => s.mediaId === mediaId) ?? null;
  }
  return null;
}

// Result of expanding an @template reference inside a block, per the
// 展开与续接规范:
//  - `lines`: the expansion block, `# 模板名` header (when the template's
//    Phase 1 title rule allows it) followed by the kept content lines.
//  - `trailingBlank`: whether the template's content ends with one or more
//    empty paragraphs. Used by the serializer as a SIGNAL to force the block's
//    后文 onto a new paragraph (Rule 2). The trailing empty paragraph itself is
//    NOT rendered as a blank line.
export interface TemplateExpansion {
  lines: StyledLine[];
  trailingBlank: boolean;
}

interface ExpandTemplateInput {
  name: string;
  includeTitle: boolean;
  content: JSONContent | null | undefined;
}

// Expand an @template reference into its serialized line sequence. Pure so it
// can be unit-tested against the baseline cases.
//
// Rules (展开与续接规范, Phase 3 定稿):
//  - First line `# 模板名` when includeTitle && name.trim() && name !==
//    '未命名模板' — INDEPENDENT of how many roles are checked (even `@角色[]`
//    outputs the title).
//  - Walk the template content paragraphs in order:
//      * A paragraph that CONTAINS a roleEntity whose id is NOT in
//        `selectedRoleIds` is DROPPED entirely.
//      * A paragraph with a checked-role entity, or with NO role entity at all
//        (plain text), is KEPT verbatim: the author's `- `, colon and extra
//        text all survive; roleEntity -> its name; mention -> `Image{n}`
//        (code) / baseName (name) resolved against THIS BLOCK's merged image
//        list `blockImages`; a mention whose mediaId isn't in the block list is
//        dropped.
//      * An internal EMPTY paragraph is kept as a blank line.
//  - Trailing empty paragraphs are collapsed to a single `trailingBlank`
//    signal and are NOT emitted as blank lines.
export function expandTemplateRef(
  tpl: ExpandTemplateInput,
  selectedRoleIds: string[],
  blockImages: GenImageItem[],
  mode: ChipMode
): TemplateExpansion {
  const lines: StyledLine[] = [];

  const titleOk =
    tpl.includeTitle && !!tpl.name.trim() && tpl.name !== '未命名模板';
  if (titleOk) {
    const titleText = `# ${tpl.name}`;
    lines.push({
      text: titleText,
      styles: Array.from({ length: titleText.length }, () => ({ ...EMPTY_STYLE })),
    });
  }

  const paragraphs = (tpl.content?.content ?? []).filter(
    (n) => n.type === 'paragraph'
  );

  // A paragraph is "empty" when it renders to no text (no children, or only
  // whitespace text). Such trailing paragraphs act as the Rule-2 signal.
  const renderParagraph = (para: JSONContent): StyledLine | null => {
    const children = para.content ?? [];
    // Drop the whole line if it carries an UNchecked role.
    const hasUncheckedRole = children.some(
      (c) =>
        c.type === 'roleEntity' &&
        !selectedRoleIds.includes((c.attrs?.id as string) ?? '')
    );
    if (hasUncheckedRole) return null;

    const lineText: string[] = [];
    const lineStyles: CharacterStyle[] = [];
    let afterRole = false;
    for (const c of children) {
      if (c.type === 'roleEntity') {
        // Implied leading dash the editor hides.
        const roleText = `- ${(c.attrs?.name as string) ?? ''}`;
        const style = marksToStyle(c.marks);
        appendStyled(roleText, style, lineText, lineStyles);
        afterRole = true;
      } else if (c.type === 'mention') {
        const mediaId = c.attrs?.mediaId as number | undefined;
        afterRole = false;
        if (mediaId == null) continue;
        const idx = blockImages.findIndex((it) => it.mediaId === mediaId);
        if (idx < 0) continue; // not in this block's list -> drop reference
        const mentionText = mode === 'code'
          ? `Image${idx + 1}`
          : baseName((c.attrs?.name as string) ?? '');
        const style = marksToStyle(c.marks);
        appendStyled(mentionText, style, lineText, lineStyles);
      } else if (c.type === 'text') {
        let t = c.text ?? '';
        // The colon right after a role -> normalize to `: `.
        if (afterRole) t = t.replace(/^\s*[：:]\s*/, ': ');
        const style = marksToStyle(c.marks);
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

  // Compute how many trailing paragraphs are blank (they only signal Rule 2).
  const isBlankParagraph = (para: JSONContent): boolean => {
    const children = para.content ?? [];
    if (children.length === 0) return true;
    return children.every(
      (c) => c.type === 'text' && !((c.text ?? '').trim())
    );
  };
  let lastNonBlank = paragraphs.length - 1;
  while (lastNonBlank >= 0 && isBlankParagraph(paragraphs[lastNonBlank])) {
    lastNonBlank--;
  }
  const trailingBlank = lastNonBlank < paragraphs.length - 1;

  for (let i = 0; i <= lastNonBlank; i++) {
    const rendered = renderParagraph(paragraphs[i]);
    if (rendered === null) continue; // unchecked-role line dropped
    lines.push(rendered); // internal blank paragraphs -> empty line preserved
  }

  return { lines, trailingBlank };
}

// Compose one block paragraph that contains a @template node, per the
// 续接规范 (pure, so the serializer and its tests share the exact same logic):
//  - `before` (前文, already inline-rendered): if it has any non-whitespace
//    char it is FORCED onto its own line (so `# 标题` always starts a line);
//    trailing spaces trimmed.
//  - `expansion` / `trailingBlank`: the resolved template block.
//  - `after` (后文, already inline-rendered):
//      * Rule 1: after non-empty AND !trailingBlank AND expansion non-empty ->
//        append after to the LAST expansion line with a single space.
//      * Rule 2: after empty OR trailingBlank -> expansion, then after as a new
//        line (only when after is non-empty).
// Returns the output lines for this paragraph.
export function composeTemplateBlock(
  before: StyledLine,
  expansion: StyledLine[],
  trailingBlank: boolean,
  after: StyledLine
): StyledLine[] {
  const out: StyledLine[] = [];
  const trimmedBefore = trimTrailing(before);
  if (trimmedBefore.text.trim().length > 0) out.push(trimmedBefore);

  const lines = [...expansion];
  const afterHasContent = after.text.trim().length > 0;
  if (afterHasContent && !trailingBlank && lines.length > 0) {
    // Add space + after to last line
    const lastLine = lines[lines.length - 1];
    const spaceStyle = { ...EMPTY_STYLE };
    const spaceLine: StyledLine = {
      text: ' ',
      styles: [spaceStyle],
    };
    lines[lines.length - 1] = concatLines(concatLines(lastLine, spaceLine), after);
    out.push(...lines);
  } else {
    out.push(...lines);
    if (afterHasContent) out.push(after);
  }
  return out;
}
