import type { JSONContent } from '@tiptap/react';
import { baseName, type GenImageItem } from '../../context/GenImagesContext';
import type { ChipMode } from '../../context/GenSettingsContext';
import { composeTemplateBlock } from './roleUtils';
import type { ResolvedTemplateRef } from './GenPromptEditor';

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
): string {
  if (!content) return '';
  const out: string[] = [];

  const renderInline = (nodes: JSONContent[]): string => {
    let s = '';
    let afterRole = false;
    for (const child of nodes) {
      if (child.type === 'mention') {
        const slotId = child.attrs?.slotId as string | undefined;
        const name = (child.attrs?.name as string) ?? '';
        const idx = images.findIndex((it) => it.id === slotId);
        afterRole = false;
        if (idx < 0) continue; // slot removed -> drop the reference
        s += mode === 'code' ? `Image${idx + 1}` : baseName(name);
      } else if (child.type === 'roleEntity') {
        // Implied leading dash the editor hides.
        s += `- ${(child.attrs?.name as string) ?? ''}`;
        afterRole = true;
      } else if (child.type === 'text') {
        let t = child.text ?? '';
        if (afterRole) t = t.replace(/^\s*[：:]\s*/, ': ');
        s += t;
        afterRole = false;
      } else {
        afterRole = false;
      }
    }
    return s;
  };

  for (const block of content.content ?? []) {
    const children = block.content ?? [];
    const tIdx = children.findIndex((c) => c.type === 'templateRef');

    if (tIdx < 0) {
      // No @template: a plain line (may be empty).
      out.push(renderInline(children));
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
    const after = renderInline(children.slice(tIdx + 1)).replace(/^[ \t]+/, '');

    if (!resolved) {
      // Template gone: merge 前文 + 后文 into one line.
      out.push((before + after).replace(/^[ \t]+|[ \t]+$/g, ''));
      continue;
    }

    out.push(
      ...composeTemplateBlock(
        before,
        resolved.lines,
        resolved.trailingBlank,
        after
      )
    );
  }

  return out.join('\n');
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
): string {
  const segments: string[] = [];

  for (const cell of cells) {
    const body = serializePromptContent(cell.note, cell.images, mode);
    if (body.trim()) segments.push(body);
  }

  for (const t of templates) {
    const body = serializePromptContent(t.content, t.images, mode);
    const title = t.includeTitle ? t.name.trim() : '';
    const withTitle =
      title && title !== '未命名模板' ? `# ${title}\n${body}` : body;
    if (withTitle.trim()) segments.push(withTitle);
  }

  for (const b of blocks) {
    const body = serializePromptContent(
      b.content,
      b.images,
      mode,
      resolveTemplateRef
    );
    if (body.trim()) segments.push(body);
  }

  return segments.join('\n\n');
}
