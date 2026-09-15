// ============================================================================
// 查询层：把 SQLite 里的行组装成工具要返回的形状
//
// 按方案的决定，每个返回提示词的查询都同时给出「展开后的纯文本」和「结构化字段」：
// 文本是 App 内「复制全部」的等价物，客户端拿到就能直接投喂；结构化字段（素材
// 路径、角色、引用关系）供需要精细处理的客户端使用。
// ============================================================================

import type { ReadonlyDb } from './db.ts';
import {
  makeTemplateResolver,
  serializeCard,
  parseContent,
  type SlotRow,
} from './serialize.ts';
import { rolesOf } from '../../src/components/gen/roleUtils';
import type { ChipMode } from '../../src/context/GenSettingsContext';

const SLOT_COLUMNS = 'id, media_id, name, thumb, path, meta, type';

export interface ProjectRow {
  id: number;
  name: string;
  created_at: string;
  updated_at: string;
}

export function listProjects(db: ReadonlyDb): ProjectRow[] {
  return db.all<ProjectRow>(
    'SELECT id, name, created_at, updated_at FROM projects ORDER BY updated_at DESC'
  );
}

export function getProject(db: ReadonlyDb, projectId: number): ProjectRow | undefined {
  return db.get<ProjectRow>(
    'SELECT id, name, created_at, updated_at FROM projects WHERE id = ?',
    projectId
  );
}

export interface MediaRow {
  id: number;
  project_id: number | null;
  type: 'image' | 'video' | 'audio';
  name: string;
  path: string;
  duration: string | null;
  size: string | null;
  scope: 'project' | 'common';
  folder_id: number | null;
  created_at: string;
}

export interface ListMediaFilter {
  projectId?: number;
  scope?: 'project' | 'common';
  type?: 'image' | 'video' | 'audio';
  search?: string;
  limit?: number;
}

export function listMedia(db: ReadonlyDb, filter: ListMediaFilter = {}): MediaRow[] {
  const where: string[] = [];
  const params: unknown[] = [];

  // scope='common' 的素材 project_id 为 NULL（全局公共库），所以按项目过滤时
  // 必须把公共素材一并放进来 —— 它们对该项目同样可引用。
  if (filter.projectId != null) {
    where.push("(project_id = ? OR scope = 'common')");
    params.push(filter.projectId);
  }
  if (filter.scope) {
    where.push('scope = ?');
    params.push(filter.scope);
  }
  if (filter.type) {
    where.push('type = ?');
    params.push(filter.type);
  }
  if (filter.search?.trim()) {
    where.push('name LIKE ?');
    params.push(`%${filter.search.trim()}%`);
  }

  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
  const sql =
    `SELECT id, project_id, type, name, path, duration, size, scope, folder_id, created_at
       FROM media ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY id ASC LIMIT ${limit}`;
  return db.all<MediaRow>(sql, ...params);
}

// 一张卡片的统一返回形状：文本 + 结构化。
export interface CardResult {
  id: string;
  position: number;
  // 已展开的提示词文本，等价于 App 内单卡复制的结果。
  text: string;
  // 卡片引用的素材，按卡内顺序；序号即 Image1 / 图1 的编号来源。
  media: { ordinal: number; mediaId: number; name: string; type: string; path: string }[];
}

function slotsToMedia(slots: SlotRow[]): CardResult['media'] {
  return slots.map((s, i) => ({
    ordinal: i + 1,
    mediaId: s.media_id,
    name: s.name,
    type: s.type,
    path: s.path ?? '',
  }));
}

export function getGenCells(db: ReadonlyDb, projectId: number, mode: ChipMode): CardResult[] {
  const cells = db.all<{ id: string; position: number; note: string | null }>(
    'SELECT id, position, note FROM gen_cells WHERE project_id = ? ORDER BY position',
    projectId
  );
  return cells.map((c) => {
    const slots = db.all<SlotRow>(
      `SELECT ${SLOT_COLUMNS} FROM gen_slots WHERE cell_id = ? ORDER BY position`,
      c.id
    );
    // 生图区不支持模板引用，所以不传 resolver。
    return {
      id: c.id,
      position: c.position,
      text: serializeCard(c.note, slots, mode).text,
      media: slotsToMedia(slots),
    };
  });
}

export interface TemplateResult extends CardResult {
  name: string;
  referenceable: boolean;
  includeTitle: boolean;
  // 模板里定义的角色实体，分镜区引用模板时按这些 id 勾选。
  roles: { id: string; name: string }[];
}

export function getTemplates(db: ReadonlyDb, projectId: number, mode: ChipMode): TemplateResult[] {
  const rows = db.all<{
    id: string;
    position: number;
    name: string;
    content: string | null;
    referenceable: number;
    include_title: number;
  }>(
    `SELECT id, position, name, content, referenceable, include_title
       FROM gen_templates WHERE project_id = ? ORDER BY position`,
    projectId
  );
  return rows.map((t) => {
    const slots = db.all<SlotRow>(
      `SELECT ${SLOT_COLUMNS} FROM template_slots WHERE template_id = ? ORDER BY position`,
      t.id
    );
    const content = parseContent(t.content);
    return {
      id: t.id,
      position: t.position,
      name: t.name,
      referenceable: !!t.referenceable,
      includeTitle: !!t.include_title,
      text: serializeCard(t.content, slots, mode).text,
      media: slotsToMedia(slots),
      roles: rolesOf(content).map((r) => ({ id: r.id, name: r.name })),
    };
  });
}

export interface BlockResult extends CardResult {
  combineEnabled: boolean;
}

export function getBlocks(db: ReadonlyDb, projectId: number, mode: ChipMode): BlockResult[] {
  const rows = db.all<{
    id: string;
    position: number;
    content: string | null;
    combine_enabled: number;
  }>(
    'SELECT id, position, content, combine_enabled FROM blocks WHERE project_id = ? ORDER BY position',
    projectId
  );
  // 分镜区可以引用模板，解析器按项目构建一次复用。
  const resolver = makeTemplateResolver(db, projectId);
  return rows.map((b) => {
    const slots = db.all<SlotRow>(
      `SELECT ${SLOT_COLUMNS} FROM block_slots WHERE block_id = ? ORDER BY position`,
      b.id
    );
    return {
      id: b.id,
      position: b.position,
      combineEnabled: !!b.combine_enabled,
      text: serializeCard(b.content, slots, mode, resolver).text,
      media: slotsToMedia(slots),
    };
  });
}

// 整个项目的合并提示词。刻意不调用前端的 mergeAllPrompts：那个函数为「复制全部」
// 服务，会把三个区域拼成一整块。这里按区域分段返回，客户端既能看到分段结构，也能
// 自行拼接；拼接规则（段间空行）与 mergeAllPrompts 保持一致。
export interface FullPromptResult {
  projectId: number;
  projectName: string;
  segments: { area: 'gen' | 'template' | 'storyboard'; id: string; text: string }[];
  // 与 App 内「复制全部」等价的完整文本。
  text: string;
}

export function getFullPrompt(
  db: ReadonlyDb,
  projectId: number,
  mode: ChipMode
): FullPromptResult | undefined {
  const project = getProject(db, projectId);
  if (!project) return undefined;

  const segments: FullPromptResult['segments'] = [];

  for (const c of getGenCells(db, projectId, mode)) {
    if (c.text.trim()) segments.push({ area: 'gen', id: c.id, text: c.text });
  }

  // 模板段落带 `# 名称` 标题的规则与前端一致：includeTitle 打开、且不是默认名。
  for (const t of getTemplates(db, projectId, mode)) {
    const title = t.includeTitle && t.name.trim() !== '未命名模板' ? t.name.trim() : '';
    const body = title ? `# ${title}\n${t.text}` : t.text;
    if (body.trim()) segments.push({ area: 'template', id: t.id, text: body });
  }

  for (const b of getBlocks(db, projectId, mode)) {
    if (b.text.trim()) segments.push({ area: 'storyboard', id: b.id, text: b.text });
  }

  return {
    projectId,
    projectName: project.name,
    segments,
    text: segments.map((s) => s.text).join('\n\n'),
  };
}

// 供 read_media_file 用：确认素材存在并拿到真实路径。
export function getMediaById(db: ReadonlyDb, mediaId: number): MediaRow | undefined {
  return db.get<MediaRow>(
    `SELECT id, project_id, type, name, path, duration, size, scope, folder_id, created_at
       FROM media WHERE id = ?`,
    mediaId
  );
}
