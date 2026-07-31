import { NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';

// Atom chip for a role entity created from a `- 名字：` line. It stores a stable
// `id` plus a `name` snapshot; the label is the name. A distinct purple skin
// separates it visually from the teal image @-mention chip.
export default function RoleEntityChip({ node }: NodeViewProps) {
  const name = (node.attrs.name as string) ?? '';
  return (
    <NodeViewWrapper
      as="span"
      contentEditable={false}
      className="inline-flex items-center align-baseline rounded px-1.5 py-0.5 mx-0.5 text-[12px] font-medium select-none bg-[#7C6FF0]/15 text-[#9C8CFF]"
    >
      {name || '未命名'}
    </NodeViewWrapper>
  );
}
