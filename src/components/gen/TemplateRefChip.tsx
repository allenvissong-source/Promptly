import { NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { useGenTemplateStore } from '../../context/GenTemplateStoreContext';
import { rolesOf } from './roleUtils';
import { useTemplateRefBridge } from './TemplateRefContext';

// NodeView for an @template reference in a block. Reads the target template
// live from the store so the name + role checkboxes track renames/deletions.
// Checking a role writes its id into the node's selectedRoleIds attr and asks
// the host bridge to pull that role's bound image into the block's left list.
export default function TemplateRefChip({ node, updateAttributes }: NodeViewProps) {
  const templateId = node.attrs.templateId as string;
  const selectedRoleIds = (node.attrs.selectedRoleIds as string[]) ?? [];
  const { templates } = useGenTemplateStore();
  const { onRoleChecked } = useTemplateRefBridge();

  const template = templates.find((t) => t.id === templateId);
  const roles = template ? rolesOf(template.content) : [];
  const templateName = template?.name ?? '已删除模板';

  // A selected role whose id no longer exists in the target template (role was
  // deleted). Show these as red invalid checkboxes so the user can uncheck them.
  const liveIds = new Set(roles.map((r) => r.id));
  const orphanIds = selectedRoleIds.filter((id) => !liveIds.has(id));

  const toggle = (roleId: string, checked: boolean) => {
    const next = checked
      ? [...selectedRoleIds, roleId].filter((v, i, a) => a.indexOf(v) === i)
      : selectedRoleIds.filter((id) => id !== roleId);
    updateAttributes({ selectedRoleIds: next });
    if (checked) onRoleChecked?.(templateId, roleId);
  };

  return (
    <NodeViewWrapper
      as="span"
      contentEditable={false}
      className="inline-flex items-center gap-1.5 align-baseline rounded px-1.5 py-0.5 mx-0.5 text-[12px] font-medium select-none bg-[#6C7EE1]/15 text-[#8A9BF0]"
    >
      <span className="font-semibold">@{templateName}</span>
      {roles.map((r) => {
        const checked = selectedRoleIds.includes(r.id);
        return (
          <label
            key={r.id}
            className="inline-flex items-center gap-0.5 cursor-pointer text-[#C7CFF5]"
          >
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => toggle(r.id, e.target.checked)}
              className="checkbox-dark"
              style={{ ['--cbx' as string]: '#6C7EE1' }}
            />
            <span>{r.name || '未命名'}</span>
          </label>
        );
      })}
      {orphanIds.map((id) => (
        <label
          key={id}
          className="inline-flex items-center gap-0.5 cursor-pointer text-red-400 line-through"
          title="该角色已被删除"
        >
          <input
            type="checkbox"
            checked
            onChange={() => toggle(id, false)}
            className="checkbox-dark"
            style={{ ['--cbx' as string]: '#f87171' }}
          />
          <span>已删除</span>
        </label>
      ))}
    </NodeViewWrapper>
  );
}
