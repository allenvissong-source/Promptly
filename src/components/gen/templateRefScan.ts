import type { JSONContent } from '@tiptap/react';

// 递归判断一份文档 JSON 里是否含至少一个 `templateRef`（@模板引用）节点。
// 纯函数、不依赖编辑器实例：卡片用它决定「仅本卡」按钮是否渲染。templateRef 目前
// 只出现在段落的行内层，但这里按任意层级遍历，结构变化也不会漏判。
export function contentHasTemplateRef(
  content: JSONContent | null | undefined
): boolean {
  if (!content) return false;
  if (content.type === 'templateRef') return true;
  const children = content.content;
  if (!Array.isArray(children)) return false;
  return children.some((child) => contentHasTemplateRef(child));
}
