// ============================================================================
// 提示词序列化：直接复用前端的实现，不另写一份
//
// serializePromptContent / expandTemplateRef 都是纯函数：它们的外部依赖只有
// baseName（纯字符串处理）和 EMPTY_STYLE（常量），其余全是 import type。
// 因此在 Node 里可以零改动复用，产出与 App 内「复制全部」一致的文本。
//
// 这一点是本 server 的核心设计决定：Rust 侧无法复用这些 TS 函数，只能重写一份，
// 那会让「模板引用如何展开」存在两套实现，规则一改就漂移。宁可在 Node 里跑，
// 也不接受双轨逻辑。
// ============================================================================

import type { JSONContent } from '@tiptap/react';
import { serializePromptContent } from '../../src/components/gen/serializePrompt';
import { expandTemplateRef } from '../../src/components/gen/roleUtils';
import type { GenImageItem } from '../../src/context/GenImagesContext';
import type { ChipMode } from '../../src/context/GenSettingsContext';
import type { ReadonlyDb } from './db.ts';

// 槽位行 -> 前端序列化器认识的 GenImageItem。字段与三个 *_slots 表同构。
export interface SlotRow {
  id: string;
  media_id: number;
  name: string;
  thumb: string | null;
  path: string | null;
  meta: string | null;
  type: 'image' | 'video' | 'audio';
}

// 槽位表里这几列可空，而 GenImageItem 要求非空字符串（前端展示用），因此统一
// 落到空串而不是 undefined —— 保持与 App 内 hydrate 出来的形状一致。
export function toImageItems(rows: SlotRow[]): GenImageItem[] {
  return rows.map((r) => ({
    id: r.id,
    mediaId: r.media_id,
    name: r.name,
    thumb: r.thumb ?? '',
    path: r.path ?? '',
    meta: r.meta ?? '',
    type: r.type,
  }));
}

export function parseContent(raw: string | null): JSONContent | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as JSONContent;
  } catch {
    // 单张卡片的内容坏掉不该让整个查询失败：当作空内容处理。
    return null;
  }
}

interface TemplateRow {
  id: string;
  name: string;
  content: string | null;
  include_title: number;
}

// 构造 resolveTemplateRef：形态与 StoryboardArea 里那层一致 —— 按 templateId
// 查表，然后交给 expandTemplateRef。差别只是数据来自 SQLite 而不是内存 store。
export function makeTemplateResolver(db: ReadonlyDb, projectId: number) {
  const templates = db.all<TemplateRow>(
    'SELECT id, name, content, include_title FROM gen_templates WHERE project_id = ?',
    projectId
  );
  const slotsByTemplate = new Map<string, SlotRow[]>();
  for (const row of db.all<SlotRow & { template_id: string }>(
    `SELECT id, template_id, media_id, name, thumb, path, meta, type
       FROM template_slots
      WHERE template_id IN (SELECT id FROM gen_templates WHERE project_id = ?)
      ORDER BY position`,
    projectId
  )) {
    const list = slotsByTemplate.get(row.template_id) ?? [];
    list.push(row);
    slotsByTemplate.set(row.template_id, list);
  }

  return function resolveTemplateRef(
    templateId: string,
    selectedRoleIds: string[],
    blockImages: GenImageItem[],
    mode: ChipMode
  ) {
    const tpl = templates.find((t) => t.id === templateId);
    // 模板被删掉时返回 null —— 前端序列化器有对应分支（chip 消失、前后文合并），
    // 行为与 App 内一致。
    if (!tpl) return null;
    const own = toImageItems(slotsByTemplate.get(templateId) ?? []);
    return expandTemplateRef(
      { name: tpl.name, includeTitle: !!tpl.include_title, content: parseContent(tpl.content) },
      selectedRoleIds,
      blockImages.length ? blockImages : own,
      mode
    );
  };
}

export interface SerializedCard {
  text: string;
  // styles 数组逐字符与 text 对齐，交给调用方决定要不要用。
  styleCount: number;
}

export function serializeCard(
  content: string | null,
  slots: SlotRow[],
  mode: ChipMode,
  resolver?: ReturnType<typeof makeTemplateResolver>
): SerializedCard {
  const result = serializePromptContent(parseContent(content), toImageItems(slots), mode, resolver);
  return { text: result.plainText, styleCount: result.styles.length };
}
