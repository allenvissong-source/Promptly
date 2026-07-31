import { NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { useGenImages, ordinalOf, baseName } from '../../context/GenImagesContext';
import { useGenSettings } from '../../context/GenSettingsContext';

// Atom chip rendered inside the gen-area text box for an @ reference.
// It stores a stable slot id + source material id, and displays a "skin"
// derived live from the current list order and the global display mode.
export default function MentionChip({ node }: NodeViewProps) {
  const { images } = useGenImages();
  const { chipMode } = useGenSettings();

  const slotId = node.attrs.slotId as string;
  const name = (node.attrs.name as string) ?? '';

  const ord = ordinalOf(images, slotId);
  const missing = ord == null;

  const label =
    chipMode === 'code'
      ? missing
        ? '已删除'
        : `Image${ord}`
      : baseName(name) || '未命名';

  return (
    <NodeViewWrapper
      as="span"
      data-slot-id={slotId}
      contentEditable={false}
      className={`inline-flex items-center align-baseline rounded px-1.5 py-0.5 mx-0.5 text-[12px] font-medium select-none ${
        missing
          ? 'bg-red-500/15 text-red-400'
          : 'bg-[#2EC4B6]/15 text-[#2EC4B6]'
      }`}
    >
      {label}
    </NodeViewWrapper>
  );
}
