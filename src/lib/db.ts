import Database from '@tauri-apps/plugin-sql';
import { invoke } from '@tauri-apps/api/core';
import {
  GEN_AREA_SPEC,
  TEMPLATE_AREA_SPEC,
  BLOCK_AREA_SPEC,
  buildFullWritePlan,
  buildIncrementalWritePlan,
  pickFields,
  encodeSnapshotPayload,
  decodeSnapshotPayload,
  type AreaTableSpec,
  type AreaFingerprint,
  type DesiredContainer,
  type SqlValue,
  type WritePlanStats,
  type ProjectSnapshotPayload,
} from './dbDiff';

let db: Database | null = null;

// The DB URL passed to Database.load; also handed to the Rust `execute_batch`
// command so it borrows the SAME plugin connection pool for transactions.
const DB_URL = 'sqlite:data.db';

// A single statement in an atomic batch: SQL text + positional params.
type BatchStatement = [string, (string | number | null)[]];

// Run an ordered list of statements inside ONE SQLite transaction (Rust side).
// Either all succeed (COMMIT) or none do (ROLLBACK) — used by the full-rewrite
// save functions so a mid-save failure can never leave a half-written project.
// This runs on a single pooled connection, avoiding the connection-pool wedge
// that a JS-side BEGIN/COMMIT (split across execute() calls) would cause.
async function executeBatch(statements: BatchStatement[]): Promise<void> {
  await invoke('execute_batch', { db: DB_URL, statements });
}

export interface ProjectRecord {
  id: number;
  name: string;
  cover: string | null;
  // 面板布局（显示的面板 + 拖拽分栏比例）的 JSON 快照，每个项目一份。NULL =
  // 该项目还没有自己的布局，前端回退到 localStorage 里的默认模板 / 出厂默认。
  // 不是业务数据，写入时不动 updated_at（避免影响首页排序 / 未保存标记）。
  panel_layout: string | null;
  created_at: string;
  updated_at: string;
}

export interface StorageSpace {
  id: number;
  name: string;
  root_path: string;
  created_at: string;
  updated_at: string;
}

export interface ExportFormatRule {
  id: number;
  name: string;
  pattern: string;
  enabled: number;
  sort_order: number;
  bold: number;
  italic: number;
  underline: number;
  strike: number;
  text_color: string;
  // 'style' = 老行为（命中片段着色，不改文本）；'replace' = 导出/复制时把命中
  // 片段替换成 replacement（支持 $1 捕获组）。列名用 rule_mode 而不是 mode，
  // 避免与 SQLite 里可能的关键字/PRAGMA 命名混淆。
  rule_mode: 'style' | 'replace';
  replacement: string;
  created_at: string;
  updated_at: string;
}

export type AppSettingKey =
  | 'active_storage_space_id'
  | 'chip_mode'
  | 'show_format_toolbar'
  | 'copy_as_table_cell'
  | 'apply_replace_on_export'
  | 'auto_save_enabled'
  | 'auto_save_interval_ms'
  | (string & {});

export interface AppSetting {
  key: AppSettingKey;
  value: string;
}

export interface MediaRecord {
  id: number;
  project_id: number | null;
  storage_space_id: number;
  type: 'video' | 'image' | 'audio';
  name: string;
  path: string;
  duration: string | null;
  size: string | null;
  thumb: string | null;
  preview_path: string | null;
  hash: string | null;
  created_at: string;
  scope: 'project' | 'common';
  folder_id: number | null;
}

export interface MediaFolderRecord {
  id: number;
  storage_space_id: number;
  scope: 'project' | 'common';
  project_id: number | null;
  parent_id: number | null;
  name: string;
  position: number;
  created_at: string;
}

export async function getDb(): Promise<Database> {
  if (!db) db = await Database.load(DB_URL);
  return db;
}

const SCHEMA_VERSION = 7;
const DEFAULT_STORAGE_SPACE_NAME = '默认空间';
const DEFAULT_STORAGE_ROOT_FALLBACK = 'app-data://uploads';
const DEFAULT_FORMAT_RULE_PATTERN = String.raw`@(图|图片|视频|音频)\d+`;

type TableColumn = { name: string; notnull: number };

async function tableColumns(database: Database, table: string): Promise<TableColumn[]> {
  return database.select<TableColumn[]>(`PRAGMA table_info(${table})`);
}

function legacySelect(columns: TableColumn[], name: string, fallback: string): string {
  return columns.some((column) => column.name === name) ? name : `${fallback} AS ${name}`;
}

async function resolveDefaultStorageRoot(database: Database): Promise<string> {
  try {
    const root = await invoke<string>('get_default_storage_root');
    if (root.trim()) return normalizeStorageRootPath(root);
  } catch (err) {
    console.warn('get_default_storage_root is unavailable; using a safe fallback', err);
  }
  const rows = await database.select<{ path: string }[]>(
    "SELECT path FROM media WHERE path IS NOT NULL AND path != '' ORDER BY id ASC LIMIT 100"
  ).catch(() => []);
  for (const row of rows) {
    const normalized = normalizeStorageRootPath(row.path);
    const marker = '/uploads/';
    const index = normalized.lastIndexOf(marker);
    if (index >= 0) return normalized.slice(0, index + marker.length - 1);
  }
  return DEFAULT_STORAGE_ROOT_FALLBACK;
}

async function migrateSchema(database: Database): Promise<void> {
  const versionRows = await database.select<{ user_version: number }[]>('PRAGMA user_version');
  let version = Number(versionRows[0]?.user_version ?? 0);
  if (version > SCHEMA_VERSION) throw new Error(`Database schema ${version} is newer than supported ${SCHEMA_VERSION}`);

  if (version < 1) {
    await executeBatch([
      [`CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, cover TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`, []],
      [`CREATE TABLE IF NOT EXISTS media (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, type TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, duration TEXT, size TEXT, thumb TEXT, preview_path TEXT, hash TEXT, scope TEXT NOT NULL DEFAULT 'project', folder_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`, []],
      [`CREATE TABLE IF NOT EXISTS media_folders (id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL DEFAULT 'project', project_id INTEGER, parent_id INTEGER, name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`, []],
      [`CREATE TABLE IF NOT EXISTS gen_cells (id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, position INTEGER NOT NULL DEFAULT 0, note TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`, []],
      [`CREATE TABLE IF NOT EXISTS gen_slots (id TEXT PRIMARY KEY, cell_id TEXT NOT NULL, media_id INTEGER NOT NULL, name TEXT NOT NULL, thumb TEXT, path TEXT, meta TEXT, type TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0)`, []],
      [`CREATE TABLE IF NOT EXISTS gen_templates (id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, position INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL, content TEXT, referenceable INTEGER NOT NULL DEFAULT 1, include_title INTEGER NOT NULL DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`, []],
      [`CREATE TABLE IF NOT EXISTS template_slots (id TEXT PRIMARY KEY, template_id TEXT NOT NULL, media_id INTEGER NOT NULL, name TEXT NOT NULL, thumb TEXT, path TEXT, meta TEXT, type TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0)`, []],
      [`CREATE TABLE IF NOT EXISTS blocks (id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, position INTEGER NOT NULL DEFAULT 0, content TEXT, combine_enabled INTEGER NOT NULL DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`, []],
      [`CREATE TABLE IF NOT EXISTS block_slots (id TEXT PRIMARY KEY, block_id TEXT NOT NULL, media_id INTEGER NOT NULL, name TEXT NOT NULL, thumb TEXT, path TEXT, meta TEXT, type TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0)`, []],
      ['PRAGMA user_version = 1', []],
    ]);
    version = 1;
  }

  if (version < 2) {
    const mediaColumns = await tableColumns(database, 'media');
    const folderColumns = await tableColumns(database, 'media_folders');
    const slotColumns = await tableColumns(database, 'gen_slots');
    const templateColumns = await tableColumns(database, 'gen_templates');
    const mediaNeedsRebuild = mediaColumns.length > 0 && (!mediaColumns.some((c) => c.name === 'project_id') || mediaColumns.find((c) => c.name === 'project_id')?.notnull === 1 || ['scope', 'folder_id', 'hash', 'preview_path'].some((name) => !mediaColumns.some((c) => c.name === name)));
    const statements: BatchStatement[] = [];
    if (mediaNeedsRebuild) {
      const names = ['id','project_id','type','name','path','duration','size','thumb','preview_path','hash','scope','folder_id','created_at'];
      const fallbacks: Record<string,string> = { id:'NULL', project_id:'NULL', type:"'image'", name:"''", path:"''", duration:'NULL', size:'NULL', thumb:'NULL', preview_path:'NULL', hash:'NULL', scope:"'project'", folder_id:'NULL', created_at:'CURRENT_TIMESTAMP' };
      statements.push(['DROP TABLE IF EXISTS media_migration_v2', []]);
      statements.push([`CREATE TABLE media_migration_v2 (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, type TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, duration TEXT, size TEXT, thumb TEXT, preview_path TEXT, hash TEXT, scope TEXT NOT NULL DEFAULT 'project', folder_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`, []]);
      statements.push([`INSERT INTO media_migration_v2 (${names.join(',')}) SELECT ${names.map((n) => legacySelect(mediaColumns,n,fallbacks[n])).join(',')} FROM media`, []]);
      statements.push(['DROP TABLE media', []]);
      statements.push(['ALTER TABLE media_migration_v2 RENAME TO media', []]);
    }
    if (slotColumns.length && !slotColumns.some((c) => c.name === 'path')) statements.push(['ALTER TABLE gen_slots ADD COLUMN path TEXT', []]);
    if (templateColumns.length && !templateColumns.some((c) => c.name === 'referenceable')) statements.push(['ALTER TABLE gen_templates ADD COLUMN referenceable INTEGER NOT NULL DEFAULT 1', []]);
    if (templateColumns.length && !templateColumns.some((c) => c.name === 'include_title')) statements.push(['ALTER TABLE gen_templates ADD COLUMN include_title INTEGER NOT NULL DEFAULT 1', []]);
    if (!folderColumns.length) statements.push([`CREATE TABLE media_folders (id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL DEFAULT 'project', project_id INTEGER, parent_id INTEGER, name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`, []]);
    statements.push(['CREATE INDEX IF NOT EXISTS idx_media_project ON media (project_id, type)', []]);
    statements.push(['CREATE INDEX IF NOT EXISTS idx_media_folders_scope ON media_folders (scope, project_id, parent_id)', []]);
    statements.push(['CREATE INDEX IF NOT EXISTS idx_gen_cells_project ON gen_cells (project_id, position)', []]);
    statements.push(['CREATE INDEX IF NOT EXISTS idx_gen_slots_cell ON gen_slots (cell_id, position)', []]);
    statements.push(['CREATE INDEX IF NOT EXISTS idx_gen_templates_project ON gen_templates (project_id, position)', []]);
    statements.push(['CREATE INDEX IF NOT EXISTS idx_template_slots_tpl ON template_slots (template_id, position)', []]);
    statements.push(['CREATE INDEX IF NOT EXISTS idx_blocks_project ON blocks (project_id, position)', []]);
    statements.push(['CREATE INDEX IF NOT EXISTS idx_block_slots_block ON block_slots (block_id, position)', []]);
    statements.push(['PRAGMA user_version = 2', []]);
    await executeBatch(statements);
    version = 2;
  }

  if (version < 3) {
    const defaultRoot = await resolveDefaultStorageRoot(database);
    const mediaColumns = await tableColumns(database, 'media');
    const folderColumns = await tableColumns(database, 'media_folders');
    const statements: BatchStatement[] = [
      [`CREATE TABLE IF NOT EXISTS storage_spaces (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`, []],
      [`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`, []],
      [`CREATE TABLE IF NOT EXISTS export_format_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, pattern TEXT NOT NULL, color TEXT NOT NULL, bold INTEGER NOT NULL DEFAULT 0 CHECK (bold IN (0,1)), enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)), position INTEGER NOT NULL DEFAULT 0, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`, []],
      [`INSERT OR IGNORE INTO storage_spaces (name, root_path) VALUES (?, ?)`, [DEFAULT_STORAGE_SPACE_NAME, defaultRoot]],
    ];
    if (!mediaColumns.some((c) => c.name === 'storage_space_id')) statements.push(['ALTER TABLE media ADD COLUMN storage_space_id INTEGER', []]);
    if (!folderColumns.some((c) => c.name === 'storage_space_id')) statements.push(['ALTER TABLE media_folders ADD COLUMN storage_space_id INTEGER', []]);
    statements.push([`UPDATE media SET storage_space_id = (SELECT id FROM storage_spaces WHERE root_path = ?) WHERE storage_space_id IS NULL`, [defaultRoot]]);
    statements.push([`UPDATE media_folders SET storage_space_id = (SELECT id FROM storage_spaces WHERE root_path = ?) WHERE storage_space_id IS NULL`, [defaultRoot]]);
    statements.push([`INSERT OR IGNORE INTO app_settings (key, value) SELECT 'active_storage_space_id', CAST(id AS TEXT) FROM storage_spaces WHERE root_path = ?`, [defaultRoot]]);
    statements.push([`INSERT OR IGNORE INTO app_settings (key, value) VALUES ('chip_mode', 'code')`, []]);
    statements.push([`INSERT OR IGNORE INTO app_settings (key, value) VALUES ('show_format_toolbar', 'true')`, []]);
    statements.push([`INSERT INTO export_format_rules (name, pattern, color, bold, enabled, position) SELECT '默认媒体引用', ?, '#ff0000', 1, 1, 0 WHERE NOT EXISTS (SELECT 1 FROM export_format_rules)`, [DEFAULT_FORMAT_RULE_PATTERN]]);
    statements.push(['CREATE INDEX IF NOT EXISTS idx_media_space_scope ON media (storage_space_id, scope, project_id, folder_id, type)', []]);
    statements.push(['CREATE INDEX IF NOT EXISTS idx_media_hash_destination ON media (storage_space_id, scope, project_id, folder_id, hash)', []]);
    statements.push(['CREATE INDEX IF NOT EXISTS idx_folders_space_scope ON media_folders (storage_space_id, scope, project_id, parent_id, position)', []]);
    statements.push(['PRAGMA user_version = 3', []]);
    await executeBatch(statements);
    version = 3;
  }

  if (version < 4) {
    const ruleColumns = await tableColumns(database, 'export_format_rules');
    const hasRuleColumn = (name: string) => ruleColumns.some((column) => column.name === name);
    const selectRuleColumn = (name: string, fallback: string) => hasRuleColumn(name) ? name : `${fallback} AS ${name}`;
    const textColorSource = hasRuleColumn('text_color') ? 'text_color' : hasRuleColumn('color') ? 'color AS text_color' : "'#ff0000' AS text_color";
    const sortOrderSource = hasRuleColumn('sort_order') ? 'sort_order' : hasRuleColumn('position') ? 'position AS sort_order' : '0 AS sort_order';
    const statements: BatchStatement[] = [
      ['DROP TABLE IF EXISTS export_format_rules_migration_v4', []],
      [`CREATE TABLE export_format_rules_migration_v4 (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, pattern TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)), sort_order INTEGER NOT NULL DEFAULT 0, bold INTEGER NOT NULL DEFAULT 0 CHECK (bold IN (0,1)), italic INTEGER NOT NULL DEFAULT 0 CHECK (italic IN (0,1)), underline INTEGER NOT NULL DEFAULT 0 CHECK (underline IN (0,1)), strike INTEGER NOT NULL DEFAULT 0 CHECK (strike IN (0,1)), text_color TEXT NOT NULL DEFAULT '#ff0000', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`, []],
    ];
    if (ruleColumns.length) {
      statements.push([`INSERT INTO export_format_rules_migration_v4 (id, name, pattern, enabled, sort_order, bold, italic, underline, strike, text_color, created_at, updated_at) SELECT ${selectRuleColumn('id', 'NULL')}, ${selectRuleColumn('name', "''")}, ${selectRuleColumn('pattern', "''")}, ${selectRuleColumn('enabled', '1')}, ${sortOrderSource}, ${selectRuleColumn('bold', '0')}, ${selectRuleColumn('italic', '0')}, ${selectRuleColumn('underline', '0')}, ${selectRuleColumn('strike', '0')}, ${textColorSource}, ${selectRuleColumn('created_at', 'CURRENT_TIMESTAMP')}, ${selectRuleColumn('updated_at', 'CURRENT_TIMESTAMP')} FROM export_format_rules`, []]);
      statements.push(['DROP TABLE export_format_rules', []]);
    }
    statements.push(['ALTER TABLE export_format_rules_migration_v4 RENAME TO export_format_rules', []]);
    statements.push([`INSERT INTO export_format_rules (name, pattern, enabled, sort_order, bold, italic, underline, strike, text_color) SELECT '默认媒体引用', ?, 1, 0, 1, 0, 0, 0, '#ff0000' WHERE NOT EXISTS (SELECT 1 FROM export_format_rules)`, [DEFAULT_FORMAT_RULE_PATTERN]]);
    statements.push(['PRAGMA user_version = 4', []]);
    await executeBatch(statements);
    version = 4;
  }

  // v5: 复制格式规则从「只能着色」升级为「着色 / 查找替换」二选一。
  // rule_mode='style' 保持 v4 的行为，老数据全部落在 style 上，行为零变化。
  if (version < 5) {
    const ruleColumns = await tableColumns(database, 'export_format_rules');
    const statements: BatchStatement[] = [];
    if (!ruleColumns.some((column) => column.name === 'rule_mode')) {
      statements.push([`ALTER TABLE export_format_rules ADD COLUMN rule_mode TEXT NOT NULL DEFAULT 'style'`, []]);
    }
    if (!ruleColumns.some((column) => column.name === 'replacement')) {
      statements.push([`ALTER TABLE export_format_rules ADD COLUMN replacement TEXT NOT NULL DEFAULT ''`, []]);
    }
    statements.push(['PRAGMA user_version = 5', []]);
    await executeBatch(statements);
    version = 5;
  }

  // v6: 面板布局（4 个面板的显示开关 + 拖拽分栏比例）从全局 localStorage 升级
  // 为「项目级」，落到 projects.panel_layout（JSON 文本，可空）。老项目该列为
  // NULL，前端会回退到 localStorage 里那份旧全局值，升级后布局不会突变。
  if (version < 6) {
    const projectColumns = await tableColumns(database, 'projects');
    const statements: BatchStatement[] = [];
    if (!projectColumns.some((column) => column.name === 'panel_layout')) {
      statements.push(['ALTER TABLE projects ADD COLUMN panel_layout TEXT', []]);
    }
    statements.push(['PRAGMA user_version = 6', []]);
    await executeBatch(statements);
    version = 6;
  }

  // v7: 项目快照表。「还原到本次打开项目时的状态」需要一份整项目的完整序列化
  // JSON，落到 project_snapshots.payload。纯新增表 + 新增索引，不动任何既有表 /
  // 既有列，所以老库升级不会丢数据；新表为空时全部快照 API 都退化成「没有快照」。
  if (version < 7) {
    await executeBatch([
      [
        `CREATE TABLE IF NOT EXISTS project_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL DEFAULT 'manual', schema_version INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL)`,
        [],
      ],
      ['CREATE INDEX IF NOT EXISTS idx_project_snapshots_project ON project_snapshots (project_id, id DESC)', []],
      ['PRAGMA user_version = 7', []],
    ]);
    version = 7;
  }
}

export async function initDb(): Promise<void> {
  await migrateSchema(await getDb());
}

export function normalizeStorageRootPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) throw new Error('Storage root path cannot be empty');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed.replace(/\\/g, '/').replace(/\/+$/, '');
  let normalized = trimmed.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (/^[a-z]:/i.test(normalized)) normalized = normalized[0].toUpperCase() + normalized.slice(1);
  const prefix = normalized.startsWith('/') ? '/' : normalized.match(/^[A-Z]:\//i)?.[0] ?? '';
  const remainder = prefix ? normalized.slice(prefix.length) : normalized;
  const parts: string[] = [];
  for (const part of remainder.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw new Error('Storage root path escapes its root');
      parts.pop();
    } else parts.push(part);
  }
  normalized = `${prefix}${parts.join('/')}`;
  return normalized || prefix || '.';
}

function comparableStoragePath(path: string): string {
  return normalizeStorageRootPath(path).toLocaleLowerCase();
}

export function storageRootsOverlap(a: string, b: string): boolean {
  const left = comparableStoragePath(a);
  const right = comparableStoragePath(b);
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export async function listStorageSpaces(): Promise<StorageSpace[]> {
  return (await getDb()).select<StorageSpace[]>('SELECT * FROM storage_spaces ORDER BY created_at ASC, id ASC');
}

export async function getStorageSpace(id: number): Promise<StorageSpace | null> {
  const rows = await (await getDb()).select<StorageSpace[]>('SELECT * FROM storage_spaces WHERE id = ?', [id]);
  return rows[0] ?? null;
}

export async function assertStorageRootAvailable(rootPath: string, excludeId?: number): Promise<string> {
  const normalized = normalizeStorageRootPath(rootPath);
  const spaces = await listStorageSpaces();
  const conflict = spaces.find((space) => space.id !== excludeId && storageRootsOverlap(normalized, space.root_path));
  if (conflict) throw new Error(`Storage root overlaps with “${conflict.name}”: ${conflict.root_path}`);
  return normalized;
}

export async function createStorageSpace(name: string, rootPath: string): Promise<StorageSpace> {
  const database = await getDb();
  const normalized = await assertStorageRootAvailable(rootPath);
  const result = await database.execute('INSERT INTO storage_spaces (name, root_path) VALUES (?, ?)', [name.trim(), normalized]);
  return (await getStorageSpace(result.lastInsertId as number))!;
}

export async function updateStorageSpace(id: number, updates: { name: string; rootPath: string }): Promise<void> {
  const normalized = await assertStorageRootAvailable(updates.rootPath, id);
  await (await getDb()).execute('UPDATE storage_spaces SET name = ?, root_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [updates.name.trim(), normalized, id]);
}

export async function deleteStorageSpace(id: number): Promise<void> {
  const database = await getDb();
  const counts = await database.select<{ count: number }[]>(`SELECT (SELECT COUNT(*) FROM media WHERE storage_space_id = ?) + (SELECT COUNT(*) FROM media_folders WHERE storage_space_id = ?) AS count`, [id, id]);
  if ((counts[0]?.count ?? 0) > 0) throw new Error('Cannot delete a storage space that still contains media or folders');
  await database.execute('DELETE FROM storage_spaces WHERE id = ?', [id]);
}

export async function getAppSetting(key: AppSettingKey): Promise<string | null> {
  const rows = await (await getDb()).select<AppSetting[]>('SELECT key, value FROM app_settings WHERE key = ?', [key]);
  return rows[0]?.value ?? null;
}

export async function setAppSetting(key: AppSettingKey, value: string): Promise<void> {
  await (await getDb()).execute('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
}

export async function deleteAppSetting(key: AppSettingKey): Promise<void> {
  await (await getDb()).execute('DELETE FROM app_settings WHERE key = ?', [key]);
}

const EXPORT_FORMAT_RULE_COLUMNS = 'id, name, pattern, enabled, sort_order, bold, italic, underline, strike, text_color, rule_mode, replacement, created_at, updated_at';

type MutableExportFormatRuleField = 'name' | 'pattern' | 'enabled' | 'sort_order' | 'bold' | 'italic' | 'underline' | 'strike' | 'text_color' | 'rule_mode' | 'replacement';

export async function listExportFormatRules(): Promise<ExportFormatRule[]> {
  return (await getDb()).select<ExportFormatRule[]>(`SELECT ${EXPORT_FORMAT_RULE_COLUMNS} FROM export_format_rules ORDER BY sort_order ASC, id ASC`);
}

export async function createExportFormatRule(rule: Omit<ExportFormatRule, 'id' | 'created_at' | 'updated_at'>): Promise<ExportFormatRule> {
  const database = await getDb();
  const result = await database.execute('INSERT INTO export_format_rules (name, pattern, enabled, sort_order, bold, italic, underline, strike, text_color, rule_mode, replacement) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [rule.name, rule.pattern, rule.enabled, rule.sort_order, rule.bold, rule.italic, rule.underline, rule.strike, rule.text_color, rule.rule_mode, rule.replacement]);
  const rows = await database.select<ExportFormatRule[]>(`SELECT ${EXPORT_FORMAT_RULE_COLUMNS} FROM export_format_rules WHERE id = ?`, [result.lastInsertId as number]);
  return rows[0];
}

export async function updateExportFormatRule(id: number, rule: Partial<Pick<ExportFormatRule, MutableExportFormatRuleField>>): Promise<void> {
  const entries = Object.entries(rule).filter(([, value]) => value !== undefined) as [MutableExportFormatRuleField, string | number][];
  if (!entries.length) return;
  await (await getDb()).execute(`UPDATE export_format_rules SET ${entries.map(([key]) => `${key} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [...entries.map(([, value]) => value), id]);
}

export async function deleteExportFormatRule(id: number): Promise<void> {
  await (await getDb()).execute('DELETE FROM export_format_rules WHERE id = ?', [id]);
}

export async function getProjectStorageRoots(projectId: number): Promise<StorageSpace[]> {
  return (await getDb()).select<StorageSpace[]>(`SELECT DISTINCT s.* FROM storage_spaces s JOIN media m ON m.storage_space_id = s.id WHERE m.project_id = ? UNION SELECT DISTINCT s.* FROM storage_spaces s JOIN media_folders f ON f.storage_space_id = s.id WHERE f.project_id = ? ORDER BY id`, [projectId, projectId]);
}

// ============================================
// Projects
// ============================================
export async function listProjects(): Promise<ProjectRecord[]> {
  const database = await getDb();
  return database.select<ProjectRecord[]>(
    'SELECT * FROM projects ORDER BY updated_at DESC'
  );
}

export async function createProject(name: string, storageSpaceId: number): Promise<ProjectRecord> {
  const database = await getDb();
  if (!(await getStorageSpace(storageSpaceId))) throw new Error(`Storage space ${storageSpaceId} does not exist`);
  await setAppSetting('active_storage_space_id', String(storageSpaceId));
  await database.execute('INSERT INTO projects (name) VALUES (?)', [name]);
  const rows = await database.select<ProjectRecord[]>(
    'SELECT * FROM projects ORDER BY id DESC LIMIT 1'
  );
  return rows[0];
}

export async function renameProject(id: number, name: string): Promise<void> {
  const database = await getDb();
  await database.execute(
    "UPDATE projects SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [name, id]
  );
}

export async function touchProject(id: number): Promise<void> {
  const database = await getDb();
  await database.execute(
    'UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [id]
  );
}

// 面板布局：不是业务数据，所以刻意不更新 updated_at（不影响首页排序，也不参与
// Ctrl+S 的手动保存语义）。json 传 null 表示清空该项目的布局。
export async function getProjectPanelLayout(projectId: number): Promise<string | null> {
  const database = await getDb();
  const rows = await database.select<{ panel_layout: string | null }[]>(
    'SELECT panel_layout FROM projects WHERE id = ?',
    [projectId]
  );
  return rows[0]?.panel_layout ?? null;
}

export async function setProjectPanelLayout(projectId: number, json: string | null): Promise<void> {
  const database = await getDb();
  await database.execute('UPDATE projects SET panel_layout = ? WHERE id = ?', [json, projectId]);
}

export async function deleteProject(id: number): Promise<void> {
  const database = await getDb();
  await database.execute('DELETE FROM media WHERE project_id = ?', [id]);
  await database.execute('DELETE FROM media_folders WHERE project_id = ?', [id]);
  // v7: 项目没了，它的历史快照也没有意义，顺手清掉避免库里留孤儿行。
  await database.execute('DELETE FROM project_snapshots WHERE project_id = ?', [id]);
  await database.execute('DELETE FROM projects WHERE id = ?', [id]);
  // Remove the project's upload directory on the filesystem.
  try {
    await invoke('delete_project', { projectId: id });
  } catch (err) {
    console.error('Failed to remove project uploads directory', err);
  }
}

// ============================================
// Media
// ============================================
export interface ListMediaArgs {
  storageSpaceId: number;
  scope: 'project' | 'common';
  type: MediaRecord['type'];
  // Required when scope === 'project'; ignored for common scope.
  projectId?: number | null;
  // NULL / undefined = the scope root. Only direct children are returned
  // (folders are not recursed).
  folderId?: number | null;
  // When true, ignore folderId entirely and return EVERY material in the scope
  // (all folders, recursively). Used by the @ candidate pools, which browse the
  // whole scope rather than a single folder.
  allFolders?: boolean;
}

export async function listMedia(args: ListMediaArgs): Promise<MediaRecord[]> {
  const database = await getDb();
  // allFolders drops the folder filter so the query spans the whole scope.
  const folderClause = args.allFolders
    ? ''
    : args.folderId == null
      ? 'AND folder_id IS NULL'
      : 'AND folder_id = ?';
  const pushFolder = !args.allFolders && args.folderId != null;
  if (args.scope === 'common') {
    const params: (number | string)[] = [args.storageSpaceId, args.type];
    if (pushFolder) params.push(args.folderId as number);
    return database.select<MediaRecord[]>(
      `SELECT * FROM media WHERE storage_space_id = ? AND scope = 'common' AND type = ? ${folderClause} ORDER BY created_at DESC`,
      params
    );
  }
  const params: (number | string)[] = [args.storageSpaceId, args.projectId as number, args.type];
  if (pushFolder) params.push(args.folderId as number);
  return database.select<MediaRecord[]>(
    `SELECT * FROM media WHERE storage_space_id = ? AND scope = 'project' AND project_id = ? AND type = ? ${folderClause} ORDER BY created_at DESC`,
    params
  );
}

export async function insertMedia(record: Omit<MediaRecord, 'id' | 'created_at'>): Promise<void> {
  const database = await getDb();
  await database.execute(
    'INSERT INTO media (project_id, storage_space_id, type, name, path, duration, size, thumb, preview_path, hash, scope, folder_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [record.project_id, record.storage_space_id, record.type, record.name, record.path, record.duration, record.size, record.thumb, record.preview_path, record.hash, record.scope, record.folder_id]
  );
}

export async function updateMediaName(id: number, name: string): Promise<void> {
  const database = await getDb();
  await database.execute('UPDATE media SET name = ? WHERE id = ?', [name, id]);
  // Keep gen-area slots in sync so renaming a material updates its rows and
  // any @ chips that display the file name.
  await database.execute('UPDATE gen_slots SET name = ? WHERE media_id = ?', [name, id]);
  // Same for template slots.
  await database.execute('UPDATE template_slots SET name = ? WHERE media_id = ?', [name, id]);
  // Same for block slots.
  await database.execute('UPDATE block_slots SET name = ? WHERE media_id = ?', [name, id]);
}

export async function deleteMedia(id: number): Promise<void> {
  const database = await getDb();
  // Look up the physical path before removing the row so we can delete the
  // backing file too (avoids orphan files in the uploads bucket).
  const rows = await database.select<MediaRecord[]>(
    'SELECT * FROM media WHERE id = ?',
    [id]
  );
  const row = rows[0];
  // Remove the DB row.
  await database.execute('DELETE FROM media WHERE id = ?', [id]);
  // Clean up any dangling slot references so no gen/template/block slot points
  // at a media id that no longer exists.
  await database.execute('DELETE FROM gen_slots WHERE media_id = ?', [id]);
  await database.execute('DELETE FROM template_slots WHERE media_id = ?', [id]);
  await database.execute('DELETE FROM block_slots WHERE media_id = ?', [id]);
  // Best-effort physical file delete. Rust confines deletion to the row's
  // registered storage root and treats an already-missing file as success.
  if (row?.path) {
    try {
      const storageSpace = await getStorageSpace(row.storage_space_id);
      if (!storageSpace) throw new Error(`Storage space ${row.storage_space_id} does not exist`);
      await invoke('delete_media_file', {
        storageRoot: storageSpace.root_path,
        path: row.path,
      });
    } catch (err) {
      console.error('Failed to remove media file', err);
    }
  }
}

export interface ImportMediaArgs {
  storageSpaceId: number;
  scope: 'project' | 'common';
  type: MediaRecord['type'];
  sourcePath: string;
  // Required when scope === 'project'.
  projectId?: number | null;
  // Target folder (NULL = scope root).
  folderId?: number | null;
}

// Result of an import attempt. `duplicate` is set (and `record` null) when the
// same file content already exists in the target scope/project/folder, so the
// caller can notify "已存在，已跳过" without a second copy being made.
export interface ImportMediaResult {
  record: MediaRecord | null;
  duplicate: boolean;
  // The display name involved (for a user-facing "xxx 已存在" message).
  name: string;
}

export async function importMediaFile(args: ImportMediaArgs): Promise<ImportMediaResult> {
  const database = await getDb();
  const projectId = args.scope === 'common' ? null : (args.projectId as number);
  const folderId = args.folderId ?? null;
  await assertFolderDestination({ storageSpaceId: args.storageSpaceId, scope: args.scope, projectId, folderId });
  // The display name should stay the original file name, taken from the source.
  const displayName = args.sourcePath.replace(/^.*[\\/]/, '');

  // B2: dedup by content hash. Hash the SOURCE file first; if an identical file
  // already lives in the same destination (scope + project + folder), skip the
  // copy+insert entirely and report it as a duplicate.
  let hash: string | null = null;
  try {
    hash = await invoke<string>('file_hash', { path: args.sourcePath });
  } catch (err) {
    // Hashing failure is non-fatal — fall back to importing without dedup.
    console.error('file_hash failed; importing without dedup', err);
  }
  if (hash) {
    const scopeClause =
      args.scope === 'common' ? 'project_id IS NULL' : 'project_id = ?';
    const folderClause = folderId == null ? 'folder_id IS NULL' : 'folder_id = ?';
    const params: (string | number)[] = [args.storageSpaceId, args.scope, hash];
    if (args.scope !== 'common') params.push(projectId as number);
    if (folderId != null) params.push(folderId);
    const dupes = await database.select<MediaRecord[]>(
      `SELECT * FROM media WHERE storage_space_id = ? AND scope = ? AND hash = ? AND ${scopeClause} AND ${folderClause} LIMIT 1`,
      params
    );
    if (dupes.length > 0) {
      return { record: null, duplicate: true, name: displayName };
    }
  }

  // Rust decides the physical bucket from scope: uploads/common or
  // uploads/<projectId>. Folders are logical, so folderId is not passed to Rust.
  const storageSpace = await getStorageSpace(args.storageSpaceId);
  if (!storageSpace) throw new Error(`Storage space ${args.storageSpaceId} does not exist`);
  const destPath = await invoke<string>('import_file', {
    storageRoot: storageSpace.root_path,
    scope: args.scope,
    projectId,
    sourcePath: args.sourcePath,
  });

  // B3: extract byte size (+ duration for non-image) from the stored file.
  // Falls back to size=null / duration='00:00' when probing is unavailable, so
  // behavior never regresses on a host without ffprobe.
  let size: string | null = null;
  let duration: string | null = args.type === 'image' ? null : '00:00';
  try {
    const meta = await invoke<{ size: string | null; duration: string | null }>(
      'probe_media_meta',
      { path: destPath, kind: args.type }
    );
    if (meta.size) size = meta.size;
    if (args.type !== 'image' && meta.duration) duration = meta.duration;
  } catch (err) {
    console.error('probe_media_meta failed; using placeholders', err);
  }

  // Video cover + HEVC preview. Images use themselves as the thumb; videos get
  // a first-frame JPEG so the grid shows a real cover instead of a placeholder,
  // and HEVC/H.265 sources (which WebView2 cannot decode) get an H.264 copy for
  // in-app preview. All of this is best-effort: if ffmpeg is missing the import
  // still succeeds, just without a cover/preview.
  let thumb: string | null = args.type === 'image' ? destPath : null;
  let previewPath: string | null = null;
  if (args.type === 'video') {
    try {
      thumb = await invoke<string>('generate_thumbnail', { path: destPath });
    } catch (err) {
      console.error('generate_thumbnail failed; no cover for this video', err);
    }
    try {
      previewPath = await invoke<string | null>('transcode_preview', {
        path: destPath,
      });
    } catch (err) {
      console.error('transcode_preview failed; preview may be audio-only', err);
    }
  }

  const record: Omit<MediaRecord, 'id' | 'created_at'> = {
    project_id: projectId,
    storage_space_id: args.storageSpaceId,
    type: args.type,
    name: displayName,
    path: destPath,
    duration,
    size,
    thumb,
    preview_path: previewPath,
    hash,
    scope: args.scope,
    folder_id: folderId,
  };

  await insertMedia(record);

  // Return the inserted row with the generated id.
  const rows = await database.select<MediaRecord[]>(
    'SELECT * FROM media WHERE path = ? ORDER BY id DESC LIMIT 1',
    [destPath]
  );
  return { record: rows[0] ?? null, duplicate: false, name: displayName };
}

// ============================================
// Material-library folders
// ============================================
export async function listFolders(
  storageSpaceId: number,
  scope: 'project' | 'common',
  projectId?: number | null
): Promise<MediaFolderRecord[]> {
  const database = await getDb();
  if (scope === 'common') {
    return database.select<MediaFolderRecord[]>(
      "SELECT * FROM media_folders WHERE storage_space_id = ? AND scope = 'common' ORDER BY position ASC, id ASC",
      [storageSpaceId]
    );
  }
  return database.select<MediaFolderRecord[]>(
    "SELECT * FROM media_folders WHERE storage_space_id = ? AND scope = 'project' AND project_id = ? ORDER BY position ASC, id ASC",
    [storageSpaceId, projectId as number]
  );
}

async function assertFolderDestination(args: {
  storageSpaceId: number;
  scope: 'project' | 'common';
  projectId: number | null;
  folderId: number | null;
}): Promise<void> {
  if (!(await getStorageSpace(args.storageSpaceId))) throw new Error(`Storage space ${args.storageSpaceId} does not exist`);
  if (args.scope === 'project' && args.projectId == null) throw new Error('Project scope requires projectId');
  if (args.folderId == null) return;
  const rows = await (await getDb()).select<MediaFolderRecord[]>(
    `SELECT * FROM media_folders WHERE id = ?`, [args.folderId]
  );
  const folder = rows[0];
  if (!folder || folder.storage_space_id !== args.storageSpaceId || folder.scope !== args.scope || folder.project_id !== args.projectId) {
    throw new Error('Folder does not belong to the requested storage destination');
  }
}

export async function createFolder(args: {
  storageSpaceId: number;
  scope: 'project' | 'common';
  projectId?: number | null;
  parentId?: number | null;
  name: string;
}): Promise<MediaFolderRecord> {
  const database = await getDb();
  const projectId = args.scope === 'common' ? null : (args.projectId as number);
  const parentId = args.parentId ?? null;
  await assertFolderDestination({ storageSpaceId: args.storageSpaceId, scope: args.scope, projectId, folderId: parentId });
  const siblings = await database.select<{ maxpos: number | null }[]>(
    `SELECT MAX(position) as maxpos FROM media_folders
     WHERE storage_space_id = ? AND scope = ? AND ${args.scope === 'common' ? 'project_id IS NULL' : 'project_id = ?'}
       AND ${parentId == null ? 'parent_id IS NULL' : 'parent_id = ?'}`,
    [
      args.storageSpaceId,
      args.scope,
      ...(args.scope === 'common' ? [] : [projectId as number]),
      ...(parentId == null ? [] : [parentId]),
    ]
  );
  const position = (siblings[0]?.maxpos ?? -1) + 1;
  await database.execute(
    'INSERT INTO media_folders (storage_space_id, scope, project_id, parent_id, name, position) VALUES (?, ?, ?, ?, ?, ?)',
    [args.storageSpaceId, args.scope, projectId, parentId, args.name, position]
  );
  const rows = await database.select<MediaFolderRecord[]>(
    'SELECT * FROM media_folders ORDER BY id DESC LIMIT 1'
  );
  return rows[0];
}

export async function renameFolder(storageSpaceId: number, id: number, name: string): Promise<void> {
  const database = await getDb();
  const rows = await database.select<MediaFolderRecord[]>('SELECT * FROM media_folders WHERE id = ?', [id]);
  if (rows[0]?.storage_space_id !== storageSpaceId) throw new Error('Folder does not belong to the requested storage space');
  await database.execute('UPDATE media_folders SET name = ? WHERE id = ?', [name, id]);
}

// B6: persist a new sibling order for folders. `orderedIds` is the full list of
// sibling folder ids (same scope/project/parent) in their desired order; each
// row's `position` is rewritten to its index. Runs atomically in one
// transaction so a reorder can never leave positions half-updated.
export async function reorderFolders(storageSpaceId: number, orderedIds: number[]): Promise<void> {
  if (orderedIds.length === 0) return;
  const placeholders = orderedIds.map(() => '?').join(',');
  const rows = await (await getDb()).select<MediaFolderRecord[]>(`SELECT * FROM media_folders WHERE id IN (${placeholders})`, orderedIds);
  if (rows.length !== orderedIds.length || rows.some((row) => row.storage_space_id !== storageSpaceId)) throw new Error('Folders do not belong to the requested storage space');
  const batch: BatchStatement[] = orderedIds.map((id, i) => [
    'UPDATE media_folders SET position = ? WHERE id = ?',
    [i, id],
  ]);
  await executeBatch(batch);
}

// Cascade-delete a folder: recursively removes descendant folders and every
// material inside them (physical files + slot references), then the folder rows.
export async function deleteFolder(storageSpaceId: number, id: number): Promise<void> {
  const database = await getDb();
  const roots = await database.select<MediaFolderRecord[]>('SELECT * FROM media_folders WHERE id = ?', [id]);
  if (roots[0]?.storage_space_id !== storageSpaceId) throw new Error('Folder does not belong to the requested storage space');
  const toDelete: number[] = [id];
  let frontier: number[] = [id];
  while (frontier.length > 0) {
    const placeholders = frontier.map(() => '?').join(',');
    const children = await database.select<{ id: number }[]>(
      `SELECT id FROM media_folders WHERE storage_space_id = ? AND parent_id IN (${placeholders})`,
      [storageSpaceId, ...frontier]
    );
    frontier = children.map((c) => c.id);
    toDelete.push(...frontier);
  }
  const idClause = toDelete.map(() => '?').join(',');
  const media = await database.select<MediaRecord[]>(
    `SELECT * FROM media WHERE storage_space_id = ? AND folder_id IN (${idClause})`,
    [storageSpaceId, ...toDelete]
  );
  for (const m of media) {
    await deleteMedia(m.id);
  }
  await database.execute(`DELETE FROM media_folders WHERE id IN (${idClause})`, toDelete);
}

// Change a material's scope/project/folder (a MOVE). When the scope changes the
// physical file is relocated to the target bucket and the stored path updated.
export async function moveMedia(
  mediaId: number,
  dest: { storageSpaceId: number; scope: 'project' | 'common'; projectId?: number | null; folderId?: number | null }
): Promise<void> {
  const database = await getDb();
  const rows = await database.select<MediaRecord[]>('SELECT * FROM media WHERE id = ?', [mediaId]);
  const row = rows[0];
  if (!row) return;
  const destProjectId = dest.scope === 'common' ? null : (dest.projectId as number);
  await assertFolderDestination({ storageSpaceId: dest.storageSpaceId, scope: dest.scope, projectId: destProjectId, folderId: dest.folderId ?? null });
  const destSpace = await getStorageSpace(dest.storageSpaceId);
  if (!destSpace) throw new Error(`Storage space ${dest.storageSpaceId} does not exist`);
  let newPath = row.path;
  if (row.scope !== dest.scope || row.storage_space_id !== dest.storageSpaceId) {
    newPath = await invoke<string>('move_media_file', {
      storageRoot: destSpace.root_path,
      scope: dest.scope,
      projectId: destProjectId,
      sourcePath: row.path,
    });
  }
  // Cover/preview are sidecar files next to the physical media. When the file is
  // relocated (scope change) those sidecars are left behind, so regenerate them
  // at the new location for videos; images use themselves as the cover. When the
  // file did not move, keep the existing cover/preview.
  let newThumb = row.thumb;
  let newPreview = row.preview_path;
  if (row.type === 'image') {
    newThumb = newPath;
  } else if (row.type === 'video' && newPath !== row.path) {
    newThumb = null;
    newPreview = null;
    try {
      newThumb = await invoke<string>('generate_thumbnail', { path: newPath });
    } catch (err) {
      console.error('generate_thumbnail failed after move', err);
    }
    try {
      newPreview = await invoke<string | null>('transcode_preview', {
        path: newPath,
      });
    } catch (err) {
      console.error('transcode_preview failed after move', err);
    }
  }
  await database.execute(
    'UPDATE media SET storage_space_id = ?, scope = ?, project_id = ?, folder_id = ?, path = ?, thumb = ?, preview_path = ? WHERE id = ?',
    [dest.storageSpaceId, dest.scope, destProjectId, dest.folderId ?? null, newPath, newThumb, newPreview, mediaId]
  );
}

// Duplicate a material into a target scope/project/folder (a COPY). The physical
// file is copied into the target bucket and a new media row is created.
export async function copyMedia(
  mediaId: number,
  dest: { storageSpaceId: number; scope: 'project' | 'common'; projectId?: number | null; folderId?: number | null }
): Promise<MediaRecord | null> {
  const database = await getDb();
  const rows = await database.select<MediaRecord[]>('SELECT * FROM media WHERE id = ?', [mediaId]);
  const row = rows[0];
  if (!row) return null;
  const destProjectId = dest.scope === 'common' ? null : (dest.projectId as number);
  await assertFolderDestination({ storageSpaceId: dest.storageSpaceId, scope: dest.scope, projectId: destProjectId, folderId: dest.folderId ?? null });
  const destSpace = await getStorageSpace(dest.storageSpaceId);
  if (!destSpace) throw new Error(`Storage space ${dest.storageSpaceId} does not exist`);
  const newPath = await invoke<string>('copy_media_file', {
    storageRoot: destSpace.root_path,
    scope: dest.scope,
    projectId: destProjectId,
    sourcePath: row.path,
  });
  const fileName = newPath.replace(/^.*[\\/]/, '');
  // The copy has a new physical path; regenerate video cover/preview there so
  // they don't point at the source's sidecars. Images use themselves as cover.
  let copyThumb: string | null = row.type === 'image' ? newPath : null;
  let copyPreview: string | null = null;
  if (row.type === 'video') {
    try {
      copyThumb = await invoke<string>('generate_thumbnail', { path: newPath });
    } catch (err) {
      console.error('generate_thumbnail failed after copy', err);
    }
    try {
      copyPreview = await invoke<string | null>('transcode_preview', {
        path: newPath,
      });
    } catch (err) {
      console.error('transcode_preview failed after copy', err);
    }
  }
  const record: Omit<MediaRecord, 'id' | 'created_at'> = {
    project_id: destProjectId,
    storage_space_id: dest.storageSpaceId,
    type: row.type,
    name: row.name || fileName,
    path: newPath,
    duration: row.duration,
    size: row.size,
    thumb: copyThumb,
    preview_path: copyPreview,
    hash: row.hash ?? null,
    scope: dest.scope,
    folder_id: dest.folderId ?? null,
  };
  await insertMedia(record);
  const inserted = await database.select<MediaRecord[]>(
    'SELECT * FROM media WHERE path = ? ORDER BY id DESC LIMIT 1',
    [newPath]
  );
  return inserted[0] ?? null;
}

// ============================================
// 区域写入（生图 / 模板 / 分镜共用的增量写入通道）
// ============================================

// 一个槽位在写库时需要的字段（三个区域的槽位表结构完全一致）。GenSlotRecord /
// TemplateSlotRecord / BlockSlotRecord 都结构兼容它。
interface AreaSlotInput {
  id: string;
  media_id: number;
  name: string;
  thumb: string | null;
  path: string | null;
  meta: string | null;
  type: 'video' | 'image' | 'audio';
}

export interface SaveAreaOptions {
  // 强制全量覆盖（DELETE 全部 + 重新 INSERT）。首次保存、schema 变更后、或任何
  // 怀疑 diff 不可信的场合的兜底入口；不传时默认走增量。
  forceFull?: boolean;
}

// 保存结果：调用方可以忽略（改造前返回 void），自动保存编排会用它判断这次到底
// 写了什么。
export interface SaveAreaResult extends WritePlanStats {
  // true = 这次退化成了全量覆盖。
  full: boolean;
  // 本次事务里的语句总数。
  statements: number;
}

function slotToDesired(slot: AreaSlotInput) {
  return {
    id: slot.id,
    fields: {
      media_id: slot.media_id,
      name: slot.name,
      thumb: slot.thumb,
      path: slot.path,
      meta: slot.meta,
      type: slot.type,
    } as Record<string, SqlValue>,
  };
}

// 读该项目在某个区域里的现状指纹（id + position + 业务列）。任何一行形状不对就
// 抛错，调用方据此退化成全量覆盖 —— 宁可多写，不能漏写。
async function readAreaFingerprint(spec: AreaTableSpec, projectId: number): Promise<AreaFingerprint> {
  const database = await getDb();
  const containerRows = await database.select<Record<string, unknown>[]>(
    `SELECT id, position, ${spec.containerColumns.join(', ')} FROM ${spec.containerTable} WHERE project_id = ?`,
    [projectId]
  );
  const slotRows = await database.select<Record<string, unknown>[]>(
    `SELECT s.id AS id, s.${spec.parentColumn} AS parent_id, s.position AS position, ${spec.slotColumns.map((c) => `s.${c}`).join(', ')}
     FROM ${spec.slotTable} s
     JOIN ${spec.containerTable} c ON c.id = s.${spec.parentColumn}
     WHERE c.project_id = ?`,
    [projectId]
  );
  return {
    containers: containerRows.map((row) => {
      if (typeof row.id !== 'string' || !Number.isFinite(Number(row.position))) {
        throw new Error(`Unexpected ${spec.containerTable} row shape`);
      }
      return { id: row.id, position: Number(row.position), fields: pickFields(spec.containerColumns, row) };
    }),
    slots: slotRows.map((row) => {
      if (typeof row.id !== 'string' || typeof row.parent_id !== 'string' || !Number.isFinite(Number(row.position))) {
        throw new Error(`Unexpected ${spec.slotTable} row shape`);
      }
      return {
        id: row.id,
        parentId: row.parent_id,
        position: Number(row.position),
        fields: pickFields(spec.slotColumns, row),
      };
    }),
  };
}

// 把一个区域的内存态写库。默认先读指纹算 diff，只写「新增 / 更新 / 删除」三组；
// 指纹读失败、期望态里有重复 id、或增量语句数不比全量少时，自动退化成全量覆盖。
// 无论走哪条路，最终都是 ONE executeBatch = 一个 SQLite 事务，要么全成要么全不成。
async function writeArea(
  spec: AreaTableSpec,
  projectId: number,
  containers: DesiredContainer[],
  opts?: SaveAreaOptions
): Promise<SaveAreaResult> {
  let plan = buildFullWritePlan(spec, projectId, containers, 'forced');
  if (!opts?.forceFull) {
    try {
      plan = buildIncrementalWritePlan(spec, projectId, containers, await readAreaFingerprint(spec, projectId));
    } catch (err) {
      // 读不到可信指纹就退回全量：数据完整性优先于语句数。
      console.warn(`Incremental diff for ${spec.containerTable} failed; falling back to a full rewrite`, err);
    }
  }
  await executeBatch(plan.statements);
  return { ...plan.stats, full: plan.full, statements: plan.statements.length };
}

// ============================================
// Gen area (生图区)
// ============================================
export interface GenSlotRecord {
  id: string;
  cell_id: string;
  media_id: number;
  name: string;
  thumb: string | null;
  path: string | null;
  meta: string | null;
  type: 'video' | 'image' | 'audio';
  position: number;
}

export interface GenCellRecord {
  id: string;
  project_id: number;
  position: number;
  note: string | null;
  created_at: string;
}

// One cell with its ordered slots, ready to hydrate the UI.
export interface GenCellWithSlots {
  id: string;
  note: string | null;
  slots: GenSlotRecord[];
}

export async function loadGenCells(projectId: number): Promise<GenCellWithSlots[]> {
  const database = await getDb();
  const cells = await database.select<GenCellRecord[]>(
    'SELECT * FROM gen_cells WHERE project_id = ? ORDER BY position ASC',
    [projectId]
  );
  if (cells.length === 0) return [];
  const slots = await database.select<GenSlotRecord[]>(
    `SELECT s.* FROM gen_slots s
     JOIN gen_cells c ON c.id = s.cell_id
     WHERE c.project_id = ?
     ORDER BY s.position ASC`,
    [projectId]
  );
  return cells.map((c) => ({
    id: c.id,
    note: c.note,
    slots: slots.filter((s) => s.cell_id === c.id),
  }));
}

// 一个项目的生图区写库。改造前是「DELETE 全部 + 全部重新 INSERT」；现在默认先
// 和库里的现状做 diff，只写真正变化的卡片 / 槽位（forceFull 走老的全量路径）。
// 两条路径都只发一次 executeBatch，也就是同一个 SQLite 事务：中途失败整体回滚，
// 绝不会留下半写状态。批量跑在 Rust 侧的单条池化连接上，所以不会踩 JS 侧手写
// BEGIN/COMMIT（跨多次 execute()）会造成的连接池死锁。
export async function saveGenCells(
  projectId: number,
  cells: {
    id: string;
    note: string | null;
    slots: Omit<GenSlotRecord, 'cell_id' | 'position'>[];
  }[],
  opts?: SaveAreaOptions
): Promise<SaveAreaResult> {
  return writeArea(GEN_AREA_SPEC, projectId, genCellsToDesired(cells), opts);
}

function genCellsToDesired(
  cells: { id: string; note: string | null; slots: AreaSlotInput[] }[]
): DesiredContainer[] {
  return cells.map((cell) => ({
    id: cell.id,
    fields: { note: cell.note },
    slots: cell.slots.map(slotToDesired),
  }));
}

// ============================================
// Template area (模板区)
// ============================================
export interface GenTemplateRecord {
  id: string;
  project_id: number;
  position: number;
  name: string;
  content: string | null;
  referenceable: number;
  include_title: number;
  created_at: string;
}

// A template's image slot (same shape as a gen slot, scoped to a template).
export interface TemplateSlotRecord {
  id: string;
  template_id: string;
  media_id: number;
  name: string;
  thumb: string | null;
  path: string | null;
  meta: string | null;
  type: 'video' | 'image' | 'audio';
  position: number;
}

// One template ready to hydrate the UI (content parsed by the caller), with its
// ordered image slots.
export interface GenTemplateData {
  id: string;
  name: string;
  content: string | null;
  referenceable: boolean;
  includeTitle: boolean;
  slots: TemplateSlotRecord[];
}

export async function loadTemplates(projectId: number): Promise<GenTemplateData[]> {
  const database = await getDb();
  const rows = await database.select<GenTemplateRecord[]>(
    'SELECT * FROM gen_templates WHERE project_id = ? ORDER BY position ASC',
    [projectId]
  );
  if (rows.length === 0) return [];
  const slots = await database.select<TemplateSlotRecord[]>(
    `SELECT s.* FROM template_slots s
     JOIN gen_templates t ON t.id = s.template_id
     WHERE t.project_id = ?
     ORDER BY s.position ASC`,
    [projectId]
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    content: r.content,
    referenceable: r.referenceable !== 0,
    includeTitle: r.include_title !== 0,
    slots: slots.filter((s) => s.template_id === r.id),
  }));
}

// 模板区写库。默认增量，forceFull 退回全量覆盖；同样是单个 executeBatch 事务
// （与 saveGenCells 同一套通道）。
export async function saveTemplates(
  projectId: number,
  templates: {
    id: string;
    name: string;
    content: string | null;
    referenceable: boolean;
    includeTitle: boolean;
    slots: Omit<TemplateSlotRecord, 'template_id' | 'position'>[];
  }[],
  opts?: SaveAreaOptions
): Promise<SaveAreaResult> {
  return writeArea(TEMPLATE_AREA_SPEC, projectId, templatesToDesired(templates), opts);
}

function templatesToDesired(
  templates: {
    id: string;
    name: string;
    content: string | null;
    referenceable: boolean;
    includeTitle: boolean;
    slots: AreaSlotInput[];
  }[]
): DesiredContainer[] {
  return templates.map((template) => ({
    id: template.id,
    fields: {
      name: template.name,
      content: template.content,
      referenceable: template.referenceable ? 1 : 0,
      include_title: template.includeTitle ? 1 : 0,
    },
    slots: template.slots.map(slotToDesired),
  }));
}

// ============================================
// Storyboard area (分镜区 / blocks)
// ============================================
export interface BlockRecord {
  id: string;
  project_id: number;
  position: number;
  content: string | null;
  combine_enabled: number;
  created_at: string;
}

// A block's image slot (same shape as a template slot, scoped to a block).
export interface BlockSlotRecord {
  id: string;
  block_id: string;
  media_id: number;
  name: string;
  thumb: string | null;
  path: string | null;
  meta: string | null;
  type: 'video' | 'image' | 'audio';
  position: number;
}

// One block ready to hydrate the UI, with its ordered image slots.
export interface BlockData {
  id: string;
  content: string | null;
  combineEnabled: boolean;
  slots: BlockSlotRecord[];
}

export async function loadBlocks(projectId: number): Promise<BlockData[]> {
  const database = await getDb();
  const rows = await database.select<BlockRecord[]>(
    'SELECT * FROM blocks WHERE project_id = ? ORDER BY position ASC',
    [projectId]
  );
  if (rows.length === 0) return [];
  const slots = await database.select<BlockSlotRecord[]>(
    `SELECT s.* FROM block_slots s
     JOIN blocks b ON b.id = s.block_id
     WHERE b.project_id = ?
     ORDER BY s.position ASC`,
    [projectId]
  );
  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    combineEnabled: r.combine_enabled !== 0,
    slots: slots.filter((s) => s.block_id === r.id),
  }));
}

// 分镜区写库。默认增量，forceFull 退回全量覆盖；同样是单个 executeBatch 事务
// （与 saveGenCells / saveTemplates 同一套通道）。
export async function saveBlocks(
  projectId: number,
  blocks: {
    id: string;
    content: string | null;
    combineEnabled: boolean;
    slots: Omit<BlockSlotRecord, 'block_id' | 'position'>[];
  }[],
  opts?: SaveAreaOptions
): Promise<SaveAreaResult> {
  return writeArea(BLOCK_AREA_SPEC, projectId, blocksToDesired(blocks), opts);
}

function blocksToDesired(
  blocks: { id: string; content: string | null; combineEnabled: boolean; slots: AreaSlotInput[] }[]
): DesiredContainer[] {
  return blocks.map((block) => ({
    id: block.id,
    fields: {
      content: block.content,
      combine_enabled: block.combineEnabled ? 1 : 0,
    },
    slots: block.slots.map(slotToDesired),
  }));
}

// ============================================
// Bundle export / import (data-layer helpers)
// ============================================

// Insert a media row and return its freshly generated id. Unlike insertMedia
// (which is fire-and-forget), the bundle importer needs the new id immediately
// to build the origMediaId -> newMediaId remap that rewrites every slot.
export async function insertMediaReturningId(
  record: Omit<MediaRecord, 'id' | 'created_at'>
): Promise<number> {
  const database = await getDb();
  const res = await database.execute(
    'INSERT INTO media (project_id, storage_space_id, type, name, path, duration, size, thumb, preview_path, hash, scope, folder_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [record.project_id, record.storage_space_id, record.type, record.name, record.path, record.duration, record.size, record.thumb, record.preview_path, record.hash, record.scope, record.folder_id]
  );
  return res.lastInsertId as number;
}

// Collect the set of media ids referenced by any slot across all three areas.
// Used by export to pack only the materials a project actually uses (the
// default "仅引用素材" scope) and by callers reasoning about references.
export function collectReferencedMediaIds(
  genCells: GenCellWithSlots[],
  templates: GenTemplateData[],
  blocks: BlockData[]
): Set<number> {
  const ids = new Set<number>();
  for (const c of genCells) for (const s of c.slots) ids.add(s.media_id);
  for (const t of templates) for (const s of t.slots) ids.add(s.media_id);
  for (const b of blocks) for (const s of b.slots) ids.add(s.media_id);
  return ids;
}

// Everything needed to serialize one project into a bundle: its name, the three
// areas verbatim (so Tiptap content + deterministic slot ids round-trip), the
// media rows to pack, and the project's folder tree (to rebuild layout on
// import). `media` includes the project-scoped rows in scope plus any referenced
// common rows (their scope field distinguishes them); the caller adds extra
// full-common rows when the Home "包含全部通用素材" option is on.
export interface ProjectExportPayload {
  name: string;
  // 项目级面板布局 JSON（可能为 null：老项目 / 从未调整过布局）。
  panelLayout: string | null;
  genCells: GenCellWithSlots[];
  templates: GenTemplateData[];
  blocks: BlockData[];
  media: MediaRecord[];
  folders: MediaFolderRecord[];
}

export async function exportProjectPayload(
  projectId: number,
  opts: { fullProjectMedia: boolean }
): Promise<ProjectExportPayload> {
  const database = await getDb();
  const projRows = await database.select<ProjectRecord[]>(
    'SELECT * FROM projects WHERE id = ?',
    [projectId]
  );
  const name = projRows[0]?.name ?? `项目${projectId}`;
  const panelLayout = projRows[0]?.panel_layout ?? null;
  const genCells = await loadGenCells(projectId);
  const templates = await loadTemplates(projectId);
  const blocks = await loadBlocks(projectId);
  const refIds = collectReferencedMediaIds(genCells, templates, blocks);

  // Project-scoped media: all rows for full export, else only referenced ones.
  const allProjectMedia = await database.select<MediaRecord[]>(
    "SELECT * FROM media WHERE scope = 'project' AND project_id = ?",
    [projectId]
  );
  const projectMedia = opts.fullProjectMedia
    ? allProjectMedia
    : allProjectMedia.filter((m) => refIds.has(m.id));

  // Referenced common media: slots may point at shared common materials. Pack
  // those regardless of scope option (a project isn't self-contained without
  // them). Full-common export is a Home-level concern added by the caller.
  const projectIds = new Set(allProjectMedia.map((m) => m.id));
  const missingIds = [...refIds].filter((id) => !projectIds.has(id));
  const referencedCommon: MediaRecord[] = [];
  if (missingIds.length) {
    const placeholders = missingIds.map(() => '?').join(',');
    const rows = await database.select<MediaRecord[]>(
      `SELECT * FROM media WHERE id IN (${placeholders})`,
      missingIds
    );
    for (const r of rows) if (r.scope === 'common') referencedCommon.push(r);
  }

  const media = [...projectMedia, ...referencedCommon];
  const projectSpaceIds = [...new Set(media.filter((m) => m.scope === 'project').map((m) => m.storage_space_id))];
  const folders = (await Promise.all(projectSpaceIds.map((spaceId) => listFolders(spaceId, 'project', projectId)))).flat();
  return { name, panelLayout, genCells, templates, blocks, media, folders };
}

// Overwrite-import prep: wipe a target project's material library (DB rows +
// physical files under uploads/<projectId>) so the bundle can rebuild it from
// scratch. The three areas are replaced separately by the full-rewrite save
// functions, so they are not touched here. Shared common materials are never
// affected.
export async function clearProjectMedia(projectId: number): Promise<void> {
  const database = await getDb();
  await database.execute('DELETE FROM media WHERE project_id = ?', [projectId]);
  await database.execute('DELETE FROM media_folders WHERE project_id = ?', [projectId]);
  // Wipe the project's uploads bucket on disk (delete_project only removes the
  // uploads/<pid> directory; the project row itself stays intact).
  try {
    await invoke('delete_project', { projectId });
  } catch (err) {
    console.error('Failed to clear project uploads directory', err);
  }
}

// ============================================
// 项目快照（project_snapshots，v7）
//
// 用途：给「还原到本次打开项目时的状态」提供存储与读写能力。这里只有数据层，
// 不含 UI 与触发时机。快照内容 = exportProjectPayload 的返回值（与导出 zip 的
// manifest 复用同一份序列化逻辑，避免两套逻辑漂移），外面包一层版本信息。
//
// 注意：快照表不参与项目 zip 导出 —— exportProjectPayload / bundle.ts 都不读
// project_snapshots，所以导出的永远是项目本身，不会把历史快照打进包里。
// ============================================

// 默认只保留最近 5 份，防止库无限膨胀。
export const DEFAULT_SNAPSHOT_KEEP = 5;

// 为什么抓的这份快照。开放字符串，方便下一步的自动保存编排自行扩展。
export type ProjectSnapshotReason =
  | 'project_open'
  | 'before_restore'
  | 'before_auto_save'
  | 'manual'
  | (string & {});

// 列表 / 元信息（不带 payload 正文，避免把几 MB JSON 拖进内存）。
export interface ProjectSnapshotMeta {
  id: number;
  project_id: number;
  created_at: string;
  reason: string;
  // 抓快照时的 DB schema 版本。
  schema_version: number;
  // payload 的字符长度，供 UI / 清理策略参考。
  payload_bytes: number;
}

// 完整快照：元信息 + 已解析的 payload。
export interface ProjectSnapshot extends ProjectSnapshotMeta {
  payload: ProjectSnapshotPayload<ProjectExportPayload>;
}

const SNAPSHOT_META_COLUMNS =
  'id, project_id, created_at, reason, schema_version, LENGTH(payload) AS payload_bytes';

// 抓当前库里的项目状态存为一份快照。抓的是 DB 里已落盘的状态（不是内存态），
// 所以调用方若想快照「包含未保存改动」，必须先保存再抓。
export async function createProjectSnapshot(
  projectId: number,
  reason: ProjectSnapshotReason = 'manual'
): Promise<ProjectSnapshotMeta> {
  const database = await getDb();
  const project = await exportProjectPayload(projectId, { fullProjectMedia: true });
  const payload = encodeSnapshotPayload({ schemaVersion: SCHEMA_VERSION, project });
  const result = await database.execute(
    'INSERT INTO project_snapshots (project_id, reason, schema_version, payload) VALUES (?, ?, ?, ?)',
    [projectId, reason, SCHEMA_VERSION, payload]
  );
  const rows = await database.select<ProjectSnapshotMeta[]>(
    `SELECT ${SNAPSHOT_META_COLUMNS} FROM project_snapshots WHERE id = ?`,
    [result.lastInsertId as number]
  );
  return rows[0];
}

// 最新一份在前。
export async function listProjectSnapshots(projectId: number): Promise<ProjectSnapshotMeta[]> {
  const database = await getDb();
  return database.select<ProjectSnapshotMeta[]>(
    `SELECT ${SNAPSHOT_META_COLUMNS} FROM project_snapshots WHERE project_id = ? ORDER BY id DESC`,
    [projectId]
  );
}

type ProjectSnapshotRow = ProjectSnapshotMeta & { payload: string };

// payload 解不出（版本不认识 / JSON 损坏）时返回 null，而不是抛错或半解析：调用
// 方一律当「这份快照不可用」处理。
function toProjectSnapshot(row: ProjectSnapshotRow | undefined): ProjectSnapshot | null {
  if (!row) return null;
  const payload = decodeSnapshotPayload<ProjectExportPayload>(row.payload);
  if (!payload) {
    console.error(`Project snapshot ${row.id} has an unreadable payload; treating it as missing`);
    return null;
  }
  const { payload: _payloadText, ...meta } = row;
  void _payloadText;
  return { ...meta, payload };
}

export async function getProjectSnapshot(snapshotId: number): Promise<ProjectSnapshot | null> {
  const database = await getDb();
  const rows = await database.select<ProjectSnapshotRow[]>(
    `SELECT ${SNAPSHOT_META_COLUMNS}, payload FROM project_snapshots WHERE id = ?`,
    [snapshotId]
  );
  return toProjectSnapshot(rows[0]);
}

export async function getLatestProjectSnapshot(projectId: number): Promise<ProjectSnapshot | null> {
  const database = await getDb();
  const rows = await database.select<ProjectSnapshotRow[]>(
    `SELECT ${SNAPSHOT_META_COLUMNS}, payload FROM project_snapshots WHERE project_id = ? ORDER BY id DESC LIMIT 1`,
    [projectId]
  );
  return toProjectSnapshot(rows[0]);
}

// 只保留最近 keepN 份，返回删掉的条数。keepN = 0 表示清空该项目的全部快照。
export async function pruneProjectSnapshots(
  projectId: number,
  keepN: number = DEFAULT_SNAPSHOT_KEEP
): Promise<number> {
  const keep = Math.max(0, Math.floor(keepN));
  const database = await getDb();
  const result = await database.execute(
    `DELETE FROM project_snapshots WHERE project_id = ? AND id NOT IN (
       SELECT id FROM project_snapshots WHERE project_id = ? ORDER BY id DESC LIMIT ?
     )`,
    [projectId, projectId, keep]
  );
  return result.rowsAffected;
}

export async function deleteProjectSnapshot(snapshotId: number): Promise<void> {
  await (await getDb()).execute('DELETE FROM project_snapshots WHERE id = ?', [snapshotId]);
}

export interface RestoreSnapshotOptions {
  // 是否把项目名也还原回快照时的名字。默认 false：改名是首页级操作，还原三个区域
  // 的内容不应该顺带把用户后来改的名字改回去。
  restoreName?: boolean;
}

// 覆盖式还原：把快照里的三个区域（+ 面板布局，可选项目名）写回项目。
//
// 事务边界：所有写入语句（UPDATE projects + 三个区域各自的 DELETE 全部 +
// 重新 INSERT）拼成 ONE executeBatch，也就是 ONE SQLite 事务。任一语句失败，
// Rust 侧 rollback，库回到调用前的状态 —— 不存在「只还原了生图区」的半还原态。
// 事务外的部分只有若干只读 SELECT（读快照行、读现存 media id），它们失败会在
// 开始写之前抛错，库一个字节都没被改。
//
// 刻意不还原的东西：素材行（media / media_folders）与磁盘上的物理文件。文件系统
// 操作没法跟着 SQLite 事务回滚，硬做会造成「库回滚了、文件没回滚」的更糟状态。
// payload 里仍然保留素材元信息，将来要做更彻底的还原时可以用。因此，若快照之后
// 有素材被删除，还原时会丢掉指向这些死素材的槽位行（与 bundle 导入同样的处理），
// 卡片正文里对应的 @ chip 会变成悬空引用 —— 这一点必须在 UI 层提示。
export async function restoreProjectSnapshot(
  snapshotId: number,
  opts?: RestoreSnapshotOptions
): Promise<{ projectId: number; droppedSlots: number }> {
  const database = await getDb();
  const snapshot = await getProjectSnapshot(snapshotId);
  if (!snapshot) throw new Error(`Snapshot ${snapshotId} is missing or unreadable`);
  const projectId = snapshot.project_id;
  const projects = await database.select<ProjectRecord[]>('SELECT id FROM projects WHERE id = ?', [projectId]);
  if (!projects.length) throw new Error(`Project ${projectId} no longer exists`);
  const project = snapshot.payload.project;

  // 丢掉指向已不存在素材的槽位（库里没有这行 media，写回去只会得到坏缩略图）。
  const liveMedia = new Set(
    (await database.select<{ id: number }[]>('SELECT id FROM media')).map((row) => row.id)
  );
  let droppedSlots = 0;
  const keepSlots = <T extends { media_id: number }>(slots: T[]): T[] =>
    slots.filter((slot) => {
      if (liveMedia.has(slot.media_id)) return true;
      droppedSlots += 1;
      return false;
    });

  const statements: BatchStatement[] = [];
  statements.push(
    opts?.restoreName
      ? [
          'UPDATE projects SET name = ?, panel_layout = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [project.name, project.panelLayout ?? null, projectId],
        ]
      : [
          'UPDATE projects SET panel_layout = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [project.panelLayout ?? null, projectId],
        ]
  );
  statements.push(
    ...buildFullWritePlan(
      GEN_AREA_SPEC,
      projectId,
      genCellsToDesired(
        (project.genCells ?? []).map((cell) => ({ id: cell.id, note: cell.note, slots: keepSlots(cell.slots) }))
      )
    ).statements
  );
  statements.push(
    ...buildFullWritePlan(
      TEMPLATE_AREA_SPEC,
      projectId,
      templatesToDesired(
        (project.templates ?? []).map((template) => ({
          id: template.id,
          name: template.name,
          content: template.content,
          referenceable: template.referenceable,
          includeTitle: template.includeTitle,
          slots: keepSlots(template.slots),
        }))
      )
    ).statements
  );
  statements.push(
    ...buildFullWritePlan(
      BLOCK_AREA_SPEC,
      projectId,
      blocksToDesired(
        (project.blocks ?? []).map((block) => ({
          id: block.id,
          content: block.content,
          combineEnabled: block.combineEnabled,
          slots: keepSlots(block.slots),
        }))
      )
    ).statements
  );
  await executeBatch(statements);
  return { projectId, droppedSlots };
}
