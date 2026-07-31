import { Node, InputRule, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import RoleEntityChip from './RoleEntityChip';

// Stable id for a role entity. Generated once at conversion time and kept in
// the node attrs (persisted in the host's content JSON), so a template's roles
// can be referenced by id from the Block area even after renames.
let roleSeq = 0;
const newRoleId = () =>
  `role-${Date.now().toString(36)}-${(roleSeq++).toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;

// A role line is `- <name><colon>` at the START of a paragraph (one role per
// line). The leading `- ` is CONSUMED by the rule and NOT re-emitted as text —
// the dash is implied by the roleEntity node itself and re-added only at copy /
// serialize time. The colon stays plain editable text (visible as the divider
// before the body). `：`/`:` both accepted. Empty name (`- ：`) doesn't convert.
// Groups: 1 = `- ` prefix, 2 = name, 3 = spaces before colon, 4 = colon.
const ROLE_RULE = /^(-\s+)([^\n：:]+?)(\s*)([：:])$/;

// Custom inline atom node for a named role. Mirrors MentionAtom's atom/
// non-selectable behavior so backspace deletes the whole chip. The visible
// label is the name snapshot; the id is what the Block area's @template
// checkboxes bind to.
export const RoleEntityAtom = Node.create({
  name: 'roleEntity',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-role-id'),
        renderHTML: (attrs) =>
          attrs.id ? { 'data-role-id': attrs.id } : {},
      },
      name: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-role-name') ?? '',
        renderHTML: (attrs) =>
          attrs.name ? { 'data-role-name': attrs.name } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-role-id]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes),
      (HTMLAttributes['data-role-name'] as string) || '',
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(RoleEntityChip);
  },

  addInputRules() {
    const type = this.type;
    return [
      new InputRule({
        find: ROLE_RULE,
        handler: ({ state, range, match }) => {
          const rawName = match[2] ?? '';
          const name = rawName.trim();
          if (!name) return; // empty name -> leave text as typed
          const { tr, schema } = state;
          const nodes = [];
          // The `- ` prefix (match[1]) is intentionally dropped: it is not
          // shown in the editor and is re-added by the serializers.
          nodes.push(type.create({ id: newRoleId(), name }));
          // Normalize the divider to `: ` (english colon + space) right away,
          // so the editor shows it live (not just at copy time). match[3]/[4]
          // (spaces + `：`/`:`) are discarded in favor of the canonical form.
          nodes.push(schema.text(': '));
          tr.replaceWith(range.from, range.to, nodes);
        },
      }),
    ];
  },
});
