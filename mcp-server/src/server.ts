// ============================================================================
// MCP 工具定义
//
// 两种传输（stdio / Streamable HTTP）共用这一份，transport 只在最外层装配。
//
// 全部工具只读：连接层用 readOnly 打开数据库，写入在 SQLite 层被硬阻断。这不是
// 保守，而是必须的 —— Promptly 运行时把前端内存态当唯一写入权威，它的增量保存会
// 把「库里有、内存里没有」的行 DELETE 掉，外部写入在 App 开着时没有安全窗口。
// ============================================================================

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { openReadonlyDb, type ReadonlyDb } from './db.ts';
import {
  listProjects,
  getProject,
  listMedia,
  getGenCells,
  getTemplates,
  getBlocks,
  getFullPrompt,
  getMediaById,
} from './queries.ts';
import type { ChipMode } from '../../src/context/GenSettingsContext';

export const SERVER_NAME = 'promptly';
export const SERVER_VERSION = '0.1.0';

// chipMode 决定素材引用渲染成 `Image1` 还是文件名。默认 code，与 App 默认一致。
const chipModeSchema = z
  .enum(['code', 'name'])
  .default('code')
  .describe("素材引用的显示方式：code = Image1/图1 编号，name = 文件名");

const projectIdSchema = z.number().int().positive().describe('项目 id，来自 list_projects');

// 每次工具调用都开一个新的只读连接，用完即关。
//
// 这样做而不是维持长连接，是因为 SQLite 的只读快照会固定在打开那一刻：长连接会
// 让后续调用读到过期数据，而用户在 App 里的编辑是随时发生的。每次重开的代价是
// 一次文件打开，远小于返回陈旧内容的代价。
function withDb<T>(fn: (db: ReadonlyDb) => T): T {
  const db = openReadonlyDb();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function text(value: string) {
  return { content: [{ type: 'text' as const, text: value }] };
}

function failure(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
};

export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Promptly 是本地的 AI 创作素材与提示词编排工具。这些工具以只读方式读取它的项目、' +
        '素材与编排好的提示词。提示词已展开模板引用、解析素材编号，可直接使用。' +
        '先用 list_projects 找到项目 id，再查具体内容。',
    }
  );

  server.registerTool(
    'list_projects',
    {
      title: '列出全部项目',
      description: '按最近更新时间倒序列出 Promptly 里的所有项目。其他工具需要的 projectId 从这里获取。',
      annotations: { readOnlyHint: true },
    },
    async () => json(withDb((db) => listProjects(db)))
  );

  server.registerTool(
    'get_project',
    {
      title: '查看项目概况',
      description: '返回单个项目的基本信息与三个区域（生图 / 模板 / 分镜）的卡片数量。',
      inputSchema: { projectId: projectIdSchema },
      annotations: { readOnlyHint: true },
    },
    async ({ projectId }) =>
      withDb((db) => {
        const project = getProject(db, projectId);
        if (!project) return failure(`项目 ${projectId} 不存在`);
        const counts = db.get<Record<string, number>>(
          `SELECT (SELECT count(*) FROM gen_cells     WHERE project_id = ?) AS genCells,
                  (SELECT count(*) FROM gen_templates WHERE project_id = ?) AS templates,
                  (SELECT count(*) FROM blocks        WHERE project_id = ?) AS blocks,
                  (SELECT count(*) FROM media         WHERE project_id = ?) AS projectMedia`,
          projectId,
          projectId,
          projectId,
          projectId
        );
        return json({ ...project, counts });
      })
  );

  server.registerTool(
    'list_media',
    {
      title: '列出素材',
      description:
        '列出素材库内容。按项目过滤时会同时包含全局公共素材（它们对该项目同样可引用）。' +
        '返回真实文件路径，可配合 read_media_file 查看图片内容。',
      inputSchema: {
        projectId: z.number().int().positive().optional().describe('限定某个项目（含公共素材）'),
        scope: z.enum(['project', 'common']).optional().describe('project = 项目素材，common = 公共素材'),
        type: z.enum(['image', 'video', 'audio']).optional(),
        search: z.string().optional().describe('按文件名模糊匹配'),
        limit: z.number().int().min(1).max(1000).optional().describe('最多返回条数，默认 200'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => json(withDb((db) => listMedia(db, args)))
  );

  server.registerTool(
    'get_gen_cells',
    {
      title: '读取生图区',
      description:
        '返回生图区所有 cell 的提示词与图片列表。每个 cell 内的图片编号从 Image1 重新开始。',
      inputSchema: { projectId: projectIdSchema, chipMode: chipModeSchema },
      annotations: { readOnlyHint: true },
    },
    async ({ projectId, chipMode }) =>
      json(withDb((db) => getGenCells(db, projectId, chipMode as ChipMode)))
  );

  server.registerTool(
    'get_templates',
    {
      title: '读取模板区',
      description:
        '返回模板区所有模板的提示词、素材与角色列表。角色 id 用于分镜区引用模板时的勾选。',
      inputSchema: { projectId: projectIdSchema, chipMode: chipModeSchema },
      annotations: { readOnlyHint: true },
    },
    async ({ projectId, chipMode }) =>
      json(withDb((db) => getTemplates(db, projectId, chipMode as ChipMode)))
  );

  server.registerTool(
    'get_blocks',
    {
      title: '读取分镜区',
      description:
        '返回分镜区所有卡片的提示词。其中的 @模板引用已经展开为实际内容（含被勾选角色），' +
        '与在 App 里复制得到的结果一致。',
      inputSchema: { projectId: projectIdSchema, chipMode: chipModeSchema },
      annotations: { readOnlyHint: true },
    },
    async ({ projectId, chipMode }) =>
      json(withDb((db) => getBlocks(db, projectId, chipMode as ChipMode)))
  );

  server.registerTool(
    'get_full_prompt',
    {
      title: '获取完整提示词',
      description:
        '按「生图 → 模板 → 分镜」顺序合并整个项目的提示词，等价于 App 里的「复制全部」。' +
        '同时返回分段结构，便于按区域取用。这是最常用的入口。',
      inputSchema: {
        projectId: projectIdSchema,
        chipMode: chipModeSchema,
        format: z
          .enum(['text', 'segments'])
          .default('text')
          .describe('text = 只要合并后的纯文本，segments = 连分段结构一起返回'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ projectId, chipMode, format }) =>
      withDb((db) => {
        const result = getFullPrompt(db, projectId, chipMode as ChipMode);
        if (!result) return failure(`项目 ${projectId} 不存在`);
        return format === 'text' ? text(result.text) : json(result);
      })
  );

  server.registerTool(
    'read_media_file',
    {
      title: '读取素材图片',
      description:
        '读取图片素材的实际内容，供支持多模态的客户端直接查看。仅支持图片；' +
        '视频与音频只返回路径信息，请用系统工具打开。',
      inputSchema: { mediaId: z.number().int().positive().describe('素材 id，来自 list_media') },
      annotations: { readOnlyHint: true },
    },
    async ({ mediaId }) => {
      const media = withDb((db) => getMediaById(db, mediaId));
      if (!media) return failure(`素材 ${mediaId} 不存在`);
      if (media.type !== 'image') {
        return failure(
          `素材 ${mediaId}（${media.name}）是${media.type === 'video' ? '视频' : '音频'}，` +
            `本工具只读图片。文件路径：${media.path}`
        );
      }
      const mimeType = IMAGE_MIME[extname(media.path).toLowerCase()];
      if (!mimeType) return failure(`不支持的图片格式：${media.path}`);
      try {
        const data = await readFile(media.path);
        return { content: [{ type: 'image' as const, data: data.toString('base64'), mimeType }] };
      } catch (err) {
        // 素材记录存在但文件已被移动/删除是真实场景，明确报出来而不是静默返回空。
        return failure(`读取失败：${media.path}（${(err as Error).message}）`);
      }
    }
  );

  return server;
}
