import type { JSONContent } from '@tiptap/react';
import { rolesOf } from './roleUtils';

// ============================================================================
// 纯文本 -> Tiptap JSON
//
// AI 通过 MCP 给回来的是纯文本，而编辑器存的是 Tiptap JSON。这里做反向转换，与
// serializePromptContent 尽量对称。
//
// ⚠️ 有损，且必须让调用方知道损失了什么：
//
//   - `@素材引用`（mention 节点）无法从文本恢复。文本里的 `Image1` 只是渲染结果，
//     真正的引用靠 slotId 指向具体槽位，纯文本里没有这个信息。所以写回后原有的
//     图片 chip 会变成普通文字。
//   - 富文本样式（加粗 / 颜色等）同样丢失，全部变成默认样式。
//   - `@模板引用`（templateRef）也无法恢复，展开后的文本会被当作普通文字写进去。
//
// 唯一能保住的是**角色实体**：它序列化成 `- 名字: ...` 这种固定形态，可以按行识别
// 并还原成 roleEntity 节点。这一点很重要 —— 角色 id 是分镜区引用模板时的勾选依据，
// 丢了就会让已有的引用失效。所以这里优先复用旧内容里同名角色的 id，只有确实是新
// 角色才生成新 id。
// ============================================================================

// 与 RoleEntityAtom 里的生成规则保持一致的形态。只在文本里出现了旧内容里没有的
// 角色名时才会用到。
let seq = 0;
function newRoleId(): string {
  return `role-${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

// 角色行的形态：`- 名字: 内容` 或 `- 名字：内容`（中英文冒号都要认）。
// 名字里不允许出现冒号，避免把 `- 备注: a: b` 里的第二个冒号误判。
const ROLE_LINE = /^-\s*([^:：]+)[：:]\s?(.*)$/;

export interface TextToContentOptions {
  /// 旧内容。用来复用同名角色的 id，保住分镜区已有的引用。
  previous?: JSONContent | null;
  /// 是否识别 `- 名字:` 形态的角色行。模板区需要，分镜区和生图区不需要
  /// （那两个区域没有角色实体的概念）。
  parseRoles?: boolean;
}

/**
 * 把纯文本转成编辑器能存的 Tiptap JSON。
 *
 * 每一行变成一个 paragraph，空行变成空 paragraph（编辑器 schema 里只有顶层空
 * paragraph 这一种空行形态，与 blankLines.ts 的判定口径一致）。
 */
export function textToContent(
  text: string,
  options: TextToContentOptions = {}
): JSONContent {
  const { previous, parseRoles = false } = options;

  // 旧角色名 -> 旧 id。同名角色沿用旧 id，这样模板被分镜引用时勾选状态不会失效。
  const knownRoles = new Map<string, string>();
  if (parseRoles && previous) {
    for (const role of rolesOf(previous)) {
      if (role.name && !knownRoles.has(role.name)) knownRoles.set(role.name, role.id);
    }
  }

  // 统一换行符，避免 Windows 换行导致每行末尾多一个 \r。
  const lines = text.replace(/\r\n?/g, '\n').split('\n');

  const paragraphs: JSONContent[] = lines.map((line) => {
    if (!line.trim()) {
      // 空行：不带 content 的 paragraph。与编辑器里按回车产生的形态一致。
      return { type: 'paragraph', attrs: { textAlign: null } };
    }

    if (parseRoles) {
      const match = line.match(ROLE_LINE);
      if (match) {
        const name = match[1].trim();
        const rest = match[2];
        const id = knownRoles.get(name) ?? newRoleId();
        knownRoles.set(name, id);
        const inline: JSONContent[] = [
          { type: 'roleEntity', attrs: { id, name } },
          // 序列化时角色后面跟的是 ': '，这里保持一致，往返才稳定。
          { type: 'text', text: ': ' },
        ];
        if (rest) inline.push({ type: 'text', text: rest });
        return { type: 'paragraph', attrs: { textAlign: null }, content: inline };
      }
    }

    return {
      type: 'paragraph',
      attrs: { textAlign: null },
      content: [{ type: 'text', text: line }],
    };
  });

  return { type: 'doc', content: paragraphs };
}

/**
 * 写入前给调用方的损失清单。用于在确认弹窗里如实告诉用户「这次会丢什么」，
 * 而不是等改完了才发现 chip 没了。
 */
export function describeLossyWrite(previous: JSONContent | null | undefined): string[] {
  if (!previous) return [];
  const warnings: string[] = [];
  let mentions = 0;
  let templateRefs = 0;
  const visit = (node: JSONContent | undefined) => {
    if (!node) return;
    if (node.type === 'mention') mentions += 1;
    if (node.type === 'templateRef') templateRefs += 1;
    node.content?.forEach(visit);
  };
  visit(previous);
  if (mentions > 0) warnings.push(`${mentions} 个素材引用会变成普通文字`);
  if (templateRefs > 0) warnings.push(`${templateRefs} 个模板引用会变成普通文字`);
  return warnings;
}
