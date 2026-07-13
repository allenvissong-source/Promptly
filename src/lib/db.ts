import Database from '@tauri-apps/plugin-sql';
import { invoke } from '@tauri-apps/api/core';

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
  created_at: string;
  updated_at: string;
}

export interface MediaRecord {
  id: number;
  project_id: number | null;
  type: 'video' | 'image' | 'audio';
  name: string;
  path: string;
  duration: string | null;
  size: string | null;
  thumb: string | null;
  // H.264 copy for in-app preview of HEVC/H.265 videos that WebView2 cannot
  // decode. Null when the source is already WebView-compatible or has no copy.
  preview_path: string | null;
  // B2: content hash used to dedup re-imports of an identical file within the
  // same destination (scope/project/folder). Null for pre-B2 rows.
  hash: string | null;
  created_at: string;
  scope: 'project' | 'common';
  folder_id: number | null;
}

// A logical folder in the material-library tree. Folders live only in the DB;
// physical files stay flat under uploads/common or uploads/<projectId>.
export interface MediaFolderRecord {
  id: number;
  scope: 'project' | 'common';
  project_id: number | null;
  parent_id: number | null;
  name: string;
  position: number;
  created_at: string;
}

export async function getDb(): Promise<Database> {
  if (!db) {
    db = await Database.load(DB_URL);
  }
  return db;
}

export async function initDb(): Promise<void> {
  const database = await getDb();
  // Self-heal: a legacy `media` table (pre project-isolation) lacks the
  // `project_id` column; recreate it so the app boots cleanly instead of
  // failing on every project-scoped insert/select.
  try {
    const cols = await database.select<{ name: string }[]>('PRAGMA table_info(media)');
    if (cols.length > 0 && !cols.some((c) => c.name === 'project_id')) {
      await database.execute('DROP TABLE media');
    }
  } catch (err) {
    console.error('media table check failed', err);
  }
  await database.execute(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      cover TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await database.execute(`
    CREATE TABLE IF NOT EXISTS media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      duration TEXT,
      size TEXT,
      thumb TEXT,
      preview_path TEXT,
      hash TEXT,
      scope TEXT NOT NULL DEFAULT 'project',
      folder_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await database.execute(
    'CREATE INDEX IF NOT EXISTS idx_media_project ON media (project_id, type)'
  );
  // Material-library folders (通用/项目下任意嵌套). Folders are logical only;
  // physical files stay flat under uploads/common or uploads/<projectId>.
  await database.execute(`
    CREATE TABLE IF NOT EXISTS media_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL DEFAULT 'project',
      project_id INTEGER,
      parent_id INTEGER,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await database.execute(
    'CREATE INDEX IF NOT EXISTS idx_media_folders_scope ON media_folders (scope, project_id, parent_id)'
  );
  // Gen-area (生图区) persistence: cells and their image slots, project-scoped.
  // A cell owns an ordered list of slots and a note (Tiptap JSON). Ordinals
  // (Image1/2/3) are derived from slot order at render time, not stored.
  await database.execute(`
    CREATE TABLE IF NOT EXISTS gen_cells (
      id TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await database.execute(`
    CREATE TABLE IF NOT EXISTS gen_slots (
      id TEXT PRIMARY KEY,
      cell_id TEXT NOT NULL,
      media_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      thumb TEXT,
      path TEXT,
      meta TEXT,
      type TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0
    )
  `);
  await database.execute(
    'CREATE INDEX IF NOT EXISTS idx_gen_cells_project ON gen_cells (project_id, position)'
  );
  await database.execute(
    'CREATE INDEX IF NOT EXISTS idx_gen_slots_cell ON gen_slots (cell_id, position)'
  );
  // Template area (模板区): a project owns an ordered list of templates, each a
  // named Tiptap doc (角色/场景...). @ chips inside reference project images;
  // ordinals are derived live from the image pool, only the doc JSON is stored.
  await database.execute(`
    CREATE TABLE IF NOT EXISTS gen_templates (
      id TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL,
      content TEXT,
      referenceable INTEGER NOT NULL DEFAULT 1,
      include_title INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await database.execute(
    'CREATE INDEX IF NOT EXISTS idx_gen_templates_project ON gen_templates (project_id, position)'
  );
  // Each template owns its own ordered image list (like gen cells). @ chips in
  // the template's text reference these slots; ordinals restart at 1 per
  // template. A slot is added either by dragging an image in or by @-picking a
  // library image (deduped by media_id per template).
  await database.execute(`
    CREATE TABLE IF NOT EXISTS template_slots (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL,
      media_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      thumb TEXT,
      path TEXT,
      meta TEXT,
      type TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0
    )
  `);
  await database.execute(
    'CREATE INDEX IF NOT EXISTS idx_template_slots_tpl ON template_slots (template_id, position)'
  );
  // Storyboard area (分镜区): a project owns an ordered list of blocks, each a
  // Tiptap doc that assembles image references and @template references into a
  // final storyboard text. combine_enabled toggles the @ dual-tab (image +
  // template) picker for that block.
  await database.execute(`
    CREATE TABLE IF NOT EXISTS blocks (
      id TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      content TEXT,
      combine_enabled INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await database.execute(
    'CREATE INDEX IF NOT EXISTS idx_blocks_project ON blocks (project_id, position)'
  );
  // Each block owns its own ordered image list (same shape as template_slots).
  await database.execute(`
    CREATE TABLE IF NOT EXISTS block_slots (
      id TEXT PRIMARY KEY,
      block_id TEXT NOT NULL,
      media_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      thumb TEXT,
      path TEXT,
      meta TEXT,
      type TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0
    )
  `);
  await database.execute(
    'CREATE INDEX IF NOT EXISTS idx_block_slots_block ON block_slots (block_id, position)'
  );
  // Self-heal: add gen_slots.path to DBs created before real-path copy existed.
  try {
    const scols = await database.select<{ name: string }[]>('PRAGMA table_info(gen_slots)');
    if (scols.length > 0 && !scols.some((c) => c.name === 'path')) {
      await database.execute('ALTER TABLE gen_slots ADD COLUMN path TEXT');
    }
  } catch (err) {
    console.error('gen_slots path column check failed', err);
  }
  // Self-heal: add gen_templates.referenceable / include_title to DBs created
  // before the template title-bar icons existed. Both default to on (1).
  try {
    const tcols = await database.select<{ name: string }[]>(
      'PRAGMA table_info(gen_templates)'
    );
    if (tcols.length > 0 && !tcols.some((c) => c.name === 'referenceable')) {
      await database.execute(
        'ALTER TABLE gen_templates ADD COLUMN referenceable INTEGER NOT NULL DEFAULT 1'
      );
    }
    if (tcols.length > 0 && !tcols.some((c) => c.name === 'include_title')) {
      await database.execute(
        'ALTER TABLE gen_templates ADD COLUMN include_title INTEGER NOT NULL DEFAULT 1'
      );
    }
  } catch (err) {
    console.error('gen_templates columns check failed', err);
  }
  // Self-heal: bring a legacy `media` table (project-only, NOT NULL project_id,
  // no scope/folder columns) up to the material-library schema. Adds scope /
  // folder_id via ALTER, and rebuilds the table when project_id is still
  // NOT NULL so common-scope (全局/通用) materials can carry a NULL project_id.
  try {
    const mcols = await database.select<{ name: string; notnull: number }[]>(
      'PRAGMA table_info(media)'
    );
    if (mcols.length > 0) {
      if (!mcols.some((c) => c.name === 'scope')) {
        await database.execute(
          "ALTER TABLE media ADD COLUMN scope TEXT NOT NULL DEFAULT 'project'"
        );
      }
      if (!mcols.some((c) => c.name === 'folder_id')) {
        await database.execute('ALTER TABLE media ADD COLUMN folder_id INTEGER');
      }
      // B2: content-hash column for import dedup (added to legacy DBs).
      if (!mcols.some((c) => c.name === 'hash')) {
        await database.execute('ALTER TABLE media ADD COLUMN hash TEXT');
      }
      // HEVC preview: H.264 copy path for WebView-incompatible videos.
      if (!mcols.some((c) => c.name === 'preview_path')) {
        await database.execute('ALTER TABLE media ADD COLUMN preview_path TEXT');
      }
      const pidNotNull = mcols.find((c) => c.name === 'project_id')?.notnull === 1;
      if (pidNotNull) {
        // Rebuild to relax the NOT NULL on project_id. Re-read the columns so
        // the copy includes scope/folder_id just added above.
        await database.execute('DROP TABLE IF EXISTS media_new');
        await database.execute(`
          CREATE TABLE media_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER,
            type TEXT NOT NULL,
            name TEXT NOT NULL,
            path TEXT NOT NULL,
            duration TEXT,
            size TEXT,
            thumb TEXT,
            preview_path TEXT,
            hash TEXT,
            scope TEXT NOT NULL DEFAULT 'project',
            folder_id INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);
        await database.execute(`
          INSERT INTO media_new (id, project_id, type, name, path, duration, size, thumb, preview_path, hash, scope, folder_id, created_at)
          SELECT id, project_id, type, name, path, duration, size, thumb, preview_path, hash, scope, folder_id, created_at FROM media
        `);
        await database.execute('DROP TABLE media');
        await database.execute('ALTER TABLE media_new RENAME TO media');
        await database.execute(
          'CREATE INDEX IF NOT EXISTS idx_media_project ON media (project_id, type)'
        );
      }
    }
  } catch (err) {
    console.error('media columns check failed', err);
  }
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

export async function createProject(name: string): Promise<ProjectRecord> {
  const database = await getDb();
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

export async function deleteProject(id: number): Promise<void> {
  const database = await getDb();
  await database.execute('DELETE FROM media WHERE project_id = ?', [id]);
  await database.execute('DELETE FROM media_folders WHERE project_id = ?', [id]);
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
    const params: (number | string)[] = [args.type];
    if (pushFolder) params.push(args.folderId as number);
    return database.select<MediaRecord[]>(
      `SELECT * FROM media WHERE scope = 'common' AND type = ? ${folderClause} ORDER BY created_at DESC`,
      params
    );
  }
  const params: (number | string)[] = [args.projectId as number, args.type];
  if (pushFolder) params.push(args.folderId as number);
  return database.select<MediaRecord[]>(
    `SELECT * FROM media WHERE scope = 'project' AND project_id = ? AND type = ? ${folderClause} ORDER BY created_at DESC`,
    params
  );
}

export async function insertMedia(record: Omit<MediaRecord, 'id' | 'created_at'>): Promise<void> {
  const database = await getDb();
  await database.execute(
    'INSERT INTO media (project_id, type, name, path, duration, size, thumb, preview_path, hash, scope, folder_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [record.project_id, record.type, record.name, record.path, record.duration, record.size, record.thumb, record.preview_path, record.hash, record.scope, record.folder_id]
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
  // Best-effort physical file delete (Rust confines it to the uploads dir and
  // treats an already-missing file as success).
  if (row?.path) {
    try {
      await invoke('delete_media_file', { path: row.path });
    } catch (err) {
      console.error('Failed to remove media file', err);
    }
  }
}

export interface ImportMediaArgs {
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
    const params: (string | number)[] = [args.scope, hash];
    if (args.scope !== 'common') params.push(projectId as number);
    if (folderId != null) params.push(folderId);
    const dupes = await database.select<MediaRecord[]>(
      `SELECT * FROM media WHERE scope = ? AND hash = ? AND ${scopeClause} AND ${folderClause} LIMIT 1`,
      params
    );
    if (dupes.length > 0) {
      return { record: null, duplicate: true, name: displayName };
    }
  }

  // Rust decides the physical bucket from scope: uploads/common or
  // uploads/<projectId>. Folders are logical, so folderId is not passed to Rust.
  const destPath = await invoke<string>('import_file', {
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
  scope: 'project' | 'common',
  projectId?: number | null
): Promise<MediaFolderRecord[]> {
  const database = await getDb();
  if (scope === 'common') {
    return database.select<MediaFolderRecord[]>(
      "SELECT * FROM media_folders WHERE scope = 'common' ORDER BY position ASC, id ASC"
    );
  }
  return database.select<MediaFolderRecord[]>(
    "SELECT * FROM media_folders WHERE scope = 'project' AND project_id = ? ORDER BY position ASC, id ASC",
    [projectId as number]
  );
}

export async function createFolder(args: {
  scope: 'project' | 'common';
  projectId?: number | null;
  parentId?: number | null;
  name: string;
}): Promise<MediaFolderRecord> {
  const database = await getDb();
  const projectId = args.scope === 'common' ? null : (args.projectId as number);
  const parentId = args.parentId ?? null;
  const siblings = await database.select<{ maxpos: number | null }[]>(
    `SELECT MAX(position) as maxpos FROM media_folders
     WHERE scope = ? AND ${args.scope === 'common' ? 'project_id IS NULL' : 'project_id = ?'}
       AND ${parentId == null ? 'parent_id IS NULL' : 'parent_id = ?'}`,
    [
      args.scope,
      ...(args.scope === 'common' ? [] : [projectId as number]),
      ...(parentId == null ? [] : [parentId]),
    ]
  );
  const position = (siblings[0]?.maxpos ?? -1) + 1;
  await database.execute(
    'INSERT INTO media_folders (scope, project_id, parent_id, name, position) VALUES (?, ?, ?, ?, ?)',
    [args.scope, projectId, parentId, args.name, position]
  );
  const rows = await database.select<MediaFolderRecord[]>(
    'SELECT * FROM media_folders ORDER BY id DESC LIMIT 1'
  );
  return rows[0];
}

export async function renameFolder(id: number, name: string): Promise<void> {
  const database = await getDb();
  await database.execute('UPDATE media_folders SET name = ? WHERE id = ?', [name, id]);
}

// B6: persist a new sibling order for folders. `orderedIds` is the full list of
// sibling folder ids (same scope/project/parent) in their desired order; each
// row's `position` is rewritten to its index. Runs atomically in one
// transaction so a reorder can never leave positions half-updated.
export async function reorderFolders(orderedIds: number[]): Promise<void> {
  if (orderedIds.length === 0) return;
  const batch: BatchStatement[] = orderedIds.map((id, i) => [
    'UPDATE media_folders SET position = ? WHERE id = ?',
    [i, id],
  ]);
  await executeBatch(batch);
}

// Cascade-delete a folder: recursively removes descendant folders and every
// material inside them (physical files + slot references), then the folder rows.
export async function deleteFolder(id: number): Promise<void> {
  const database = await getDb();
  const toDelete: number[] = [id];
  let frontier: number[] = [id];
  while (frontier.length > 0) {
    const placeholders = frontier.map(() => '?').join(',');
    const children = await database.select<{ id: number }[]>(
      `SELECT id FROM media_folders WHERE parent_id IN (${placeholders})`,
      frontier
    );
    frontier = children.map((c) => c.id);
    toDelete.push(...frontier);
  }
  const idClause = toDelete.map(() => '?').join(',');
  const media = await database.select<MediaRecord[]>(
    `SELECT * FROM media WHERE folder_id IN (${idClause})`,
    toDelete
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
  dest: { scope: 'project' | 'common'; projectId?: number | null; folderId?: number | null }
): Promise<void> {
  const database = await getDb();
  const rows = await database.select<MediaRecord[]>('SELECT * FROM media WHERE id = ?', [mediaId]);
  const row = rows[0];
  if (!row) return;
  const destProjectId = dest.scope === 'common' ? null : (dest.projectId as number);
  let newPath = row.path;
  if (row.scope !== dest.scope) {
    newPath = await invoke<string>('move_media_file', {
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
    'UPDATE media SET scope = ?, project_id = ?, folder_id = ?, path = ?, thumb = ?, preview_path = ? WHERE id = ?',
    [dest.scope, destProjectId, dest.folderId ?? null, newPath, newThumb, newPreview, mediaId]
  );
}

// Duplicate a material into a target scope/project/folder (a COPY). The physical
// file is copied into the target bucket and a new media row is created.
export async function copyMedia(
  mediaId: number,
  dest: { scope: 'project' | 'common'; projectId?: number | null; folderId?: number | null }
): Promise<MediaRecord | null> {
  const database = await getDb();
  const rows = await database.select<MediaRecord[]>('SELECT * FROM media WHERE id = ?', [mediaId]);
  const row = rows[0];
  if (!row) return null;
  const destProjectId = dest.scope === 'common' ? null : (dest.projectId as number);
  const newPath = await invoke<string>('copy_media_file', {
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

// Full rewrite of a project's gen area, applied atomically. All statements
// (DELETE-all + re-INSERT) run inside ONE SQLite transaction via executeBatch,
// so a mid-save failure rolls the whole thing back instead of leaving the
// project half-written. The batch runs on a single pooled connection (Rust
// side), so it does not hit the connection-pool wedge that a JS-side manual
// BEGIN/COMMIT (split across execute() calls) would.
export async function saveGenCells(
  projectId: number,
  cells: {
    id: string;
    note: string | null;
    slots: Omit<GenSlotRecord, 'cell_id' | 'position'>[];
  }[]
): Promise<void> {
  const batch: BatchStatement[] = [];
  batch.push([
    'DELETE FROM gen_slots WHERE cell_id IN (SELECT id FROM gen_cells WHERE project_id = ?)',
    [projectId],
  ]);
  batch.push(['DELETE FROM gen_cells WHERE project_id = ?', [projectId]]);
  for (let ci = 0; ci < cells.length; ci++) {
    const cell = cells[ci];
    batch.push([
      'INSERT INTO gen_cells (id, project_id, position, note) VALUES (?, ?, ?, ?)',
      [cell.id, projectId, ci, cell.note],
    ]);
    for (let si = 0; si < cell.slots.length; si++) {
      const s = cell.slots[si];
      batch.push([
        'INSERT INTO gen_slots (id, cell_id, media_id, name, thumb, path, meta, type, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [s.id, cell.id, s.media_id, s.name, s.thumb, s.path, s.meta, s.type, si],
      ]);
    }
  }
  await executeBatch(batch);
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

// Full rewrite of a project's templates and their slots, applied atomically in
// one transaction via executeBatch (same rationale as saveGenCells).
export async function saveTemplates(
  projectId: number,
  templates: {
    id: string;
    name: string;
    content: string | null;
    referenceable: boolean;
    includeTitle: boolean;
    slots: Omit<TemplateSlotRecord, 'template_id' | 'position'>[];
  }[]
): Promise<void> {
  const batch: BatchStatement[] = [];
  batch.push([
    'DELETE FROM template_slots WHERE template_id IN (SELECT id FROM gen_templates WHERE project_id = ?)',
    [projectId],
  ]);
  batch.push(['DELETE FROM gen_templates WHERE project_id = ?', [projectId]]);
  for (let i = 0; i < templates.length; i++) {
    const t = templates[i];
    batch.push([
      'INSERT INTO gen_templates (id, project_id, position, name, content, referenceable, include_title) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [t.id, projectId, i, t.name, t.content, t.referenceable ? 1 : 0, t.includeTitle ? 1 : 0],
    ]);
    for (let si = 0; si < t.slots.length; si++) {
      const s = t.slots[si];
      batch.push([
        'INSERT INTO template_slots (id, template_id, media_id, name, thumb, path, meta, type, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [s.id, t.id, s.media_id, s.name, s.thumb, s.path, s.meta, s.type, si],
      ]);
    }
  }
  await executeBatch(batch);
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

// Full rewrite of a project's blocks and their slots, applied atomically in one
// transaction via executeBatch (same rationale as saveGenCells/saveTemplates).
export async function saveBlocks(
  projectId: number,
  blocks: {
    id: string;
    content: string | null;
    combineEnabled: boolean;
    slots: Omit<BlockSlotRecord, 'block_id' | 'position'>[];
  }[]
): Promise<void> {
  const batch: BatchStatement[] = [];
  batch.push([
    'DELETE FROM block_slots WHERE block_id IN (SELECT id FROM blocks WHERE project_id = ?)',
    [projectId],
  ]);
  batch.push(['DELETE FROM blocks WHERE project_id = ?', [projectId]]);
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    batch.push([
      'INSERT INTO blocks (id, project_id, position, content, combine_enabled) VALUES (?, ?, ?, ?, ?)',
      [b.id, projectId, i, b.content, b.combineEnabled ? 1 : 0],
    ]);
    for (let si = 0; si < b.slots.length; si++) {
      const s = b.slots[si];
      batch.push([
        'INSERT INTO block_slots (id, block_id, media_id, name, thumb, path, meta, type, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [s.id, b.id, s.media_id, s.name, s.thumb, s.path, s.meta, s.type, si],
      ]);
    }
  }
  await executeBatch(batch);
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
    'INSERT INTO media (project_id, type, name, path, duration, size, thumb, preview_path, hash, scope, folder_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [record.project_id, record.type, record.name, record.path, record.duration, record.size, record.thumb, record.preview_path, record.hash, record.scope, record.folder_id]
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
  const folders = await listFolders('project', projectId);
  return { name, genCells, templates, blocks, media, folders };
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
