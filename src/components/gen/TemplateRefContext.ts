import { createContext, useContext } from 'react';

// Bridges a templateRef NodeView (rendered inside a block's editor) back to the
// host block, so checking a role can pull that role's bound image into the
// block's left image list. Provided by GenPromptEditor around its EditorContent
// (node views share the surrounding React context via @tiptap/react).
export interface TemplateRefBridge {
  // Called when a role checkbox is turned ON. The host resolves the role's
  // bound image (roleBoundImage against the target template) and adds it to the
  // current block's left list (deduped by mediaId).
  onRoleChecked?: (templateId: string, roleId: string) => void;
}

export const TemplateRefContext = createContext<TemplateRefBridge>({});

export function useTemplateRefBridge(): TemplateRefBridge {
  return useContext(TemplateRefContext);
}
