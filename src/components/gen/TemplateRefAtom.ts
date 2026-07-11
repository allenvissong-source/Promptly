import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import TemplateRefChip from './TemplateRefChip';

// An @template reference inserted in a block (分镜) when combine mode is on.
// Inline atom: stores the target template id + the set of checked role ids.
// The NodeView renders the template name followed by one inline checkbox per
// role (read live from the target template), so renames/deletions reflect.
export const TemplateRefAtom = Node.create({
  name: 'templateRef',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      templateId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-template-id'),
        renderHTML: (attrs) =>
          attrs.templateId ? { 'data-template-id': attrs.templateId } : {},
      },
      // Stored as a JSON string in the DOM attr (Tiptap attrs must survive
      // HTML round-trips); kept as a string[] in memory.
      selectedRoleIds: {
        default: [] as string[],
        parseHTML: (el) => {
          const raw = el.getAttribute('data-selected-roles');
          if (!raw) return [];
          try {
            const v = JSON.parse(raw);
            return Array.isArray(v) ? v : [];
          } catch {
            return [];
          }
        },
        renderHTML: (attrs) => {
          const ids = (attrs.selectedRoleIds as string[]) ?? [];
          return { 'data-selected-roles': JSON.stringify(ids) };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-template-id]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(TemplateRefChip);
  },
});
