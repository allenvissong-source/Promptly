import Mention from '@tiptap/extension-mention';
import { ReactNodeViewRenderer } from '@tiptap/react';
import MentionChip from './MentionChip';

// Custom @-mention node:
//  - atom, non-editable, rendered via a React NodeView (MentionChip)
//  - stores a stable `slotId` (which gen-list slot it points at) plus the
//    source `mediaId` and `name` snapshot (name used for 'name' display mode).
// The visible label is derived live in the NodeView, so reordering the list or
// flipping the global display mode re-skins every existing chip automatically.
export const MentionAtom = Mention.extend({
  name: 'mention',
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      slotId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-slot-id'),
        renderHTML: (attrs) =>
          attrs.slotId ? { 'data-slot-id': attrs.slotId } : {},
      },
      mediaId: {
        default: null,
        parseHTML: (el) => {
          const v = el.getAttribute('data-media-id');
          return v == null ? null : Number(v);
        },
        renderHTML: (attrs) =>
          attrs.mediaId == null ? {} : { 'data-media-id': String(attrs.mediaId) },
      },
      name: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-name') ?? '',
        renderHTML: (attrs) => (attrs.name ? { 'data-name': attrs.name } : {}),
      },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(MentionChip);
  },
});
