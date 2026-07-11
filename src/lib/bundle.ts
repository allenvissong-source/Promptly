import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import type { JSONContent } from '@tiptap/react';
import {
  getDb,
  listProjects,
  createProject,
  clearProjectMedia,
  exportProjectPayload,
  insertMediaReturningId,
  createFolder,
  saveGenCells,
  saveTemplates,
  saveBlocks,
  type MediaRecord,
  type MediaFolderRecord,
  type GenCellWithSlots,
  type GenTemplateData,
  type BlockData,
} from './db';

// ============================================================================
// Bundle format (schemaVersion = 1)
//
// A bundle is a single .zip written by the Rust `export_bundle` command:
//   manifest.json                        -> the Manifest below (all metadata)
//   assets/<projectSeq>/<mediaId>_<name> -> real bytes of a project material
//   assets/common/<mediaId>_<name>       -> real bytes of a common material
//
// Import (Rust `import_bundle`) extracts manifest.json + every asset into a
// neutral staging dir and returns { manifest, assets: { <assetName>: <staged
// abs path> } }. This orchestrator then materializes each staged file into its
// final uploads bucket via `import_file`, rebuilds the three areas from the
// manifest, and remaps every id so @ chips / template refs survive.
// ============================================================================

// One material's metadata in the manifest. `assetName` is the archive path
// (also the key in the import assets map) whose bytes back this material.
export interface MediaManifest {
  origMediaId: number;
  type: MediaRecord['type'];
  name: string;
  scope: 'project' | 'common';
  duration: string | null;
  size: string | null;
  hash: string | null;
  // Project-scoped only: which folder row (by original id) it lived in.
  origFolderId: number | null;
  assetName: string;
}

// A folder row carried verbatim so the tree can be rebuilt parents-first.
export interface FolderManifest {
  id: number;
  parentId: number | null;
  name: string;
  position: number;
}

export interface ProjectManifest {
  name: string;
  // The three areas verbatim from the DB load shape (content kept as JSON
  // strings, deterministic slot ids intact) so a round-trip is lossless.
  genCells: GenCellWithSlots[];
  templates: GenTemplateData[];
  blocks: BlockData[];
  // Project-scoped materials only. Referenced common materials live in the
  // top-level commonMedia set (a project isn't self-contained without them,
  // but common is shared so it is imported once, hash-deduped).
  media: MediaManifest[];
  // Folder subset needed to place this project's packed media.
  folders: FolderManifest[];
}

export interface Manifest {
  schemaVersion: 1;
  exportedAt: number;
  projects: ProjectManifest[];
  // Every common material referenced by any project, plus (when the Home
  // "包含全部通用素材" option is on) all common materials.
  commonMedia: MediaManifest[];
}

// Strip characters that are unsafe in an archive path component.
function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_');
}

// Resolve the folder subset (a media's folder plus all its ancestors) from the
// project's full folder list.
function ancestorFolders(
  leafIds: Set<number>,
  all: MediaFolderRecord[]
): FolderManifest[] {
  const byId = new Map(all.map((f) => [f.id, f]));
  const keep = new Set<number>();
  for (const id of leafIds) {
    let cur: number | null = id;
    while (cur != null && !keep.has(cur)) {
      const row = byId.get(cur);
      if (!row) break;
      keep.add(cur);
      cur = row.parent_id;
    }
  }
  return all
    .filter((f) => keep.has(f.id))
    .map((f) => ({ id: f.id, parentId: f.parent_id, name: f.name, position: f.position }));
}

// ============================================================================
// Export
// ============================================================================

export interface ExportOptions {
  // Per-project material scope: false = only referenced materials (default),
  // true = every project-scoped material (even unreferenced ones).
  fullProjectMedia: boolean;
  // Home batch export only: also pack ALL common materials (default off).
  includeAllCommon: boolean;
}

// Build the manifest + asset list for the given projects and write the bundle.
export async function exportBundle(
  destPath: string,
  projectIds: number[],
  opts: ExportOptions
): Promise<void> {
  const projects: ProjectManifest[] = [];
  const assetEntries: [string, string][] = [];
  // Dedup common materials across projects (and the all-common option) by id.
  const commonMap = new Map<number, MediaManifest>();

  const addCommon = (m: MediaRecord) => {
    if (commonMap.has(m.id)) return;
    const assetName = `common/${m.id}_${safeName(m.name)}`;
    assetEntries.push([assetName, m.path]);
    commonMap.set(m.id, {
      origMediaId: m.id,
      type: m.type,
      name: m.name,
      scope: 'common',
      duration: m.duration,
      size: m.size,
      hash: m.hash,
      origFolderId: null,
      assetName,
    });
  };

  let seq = 0;
  for (const pid of projectIds) {
    seq++;
    const payload = await exportProjectPayload(pid, {
      fullProjectMedia: opts.fullProjectMedia,
    });
    const projectMedia = payload.media.filter((m) => m.scope === 'project');
    const referencedCommon = payload.media.filter((m) => m.scope === 'common');

    const mediaManifest: MediaManifest[] = projectMedia.map((m) => {
      const assetName = `${seq}/${m.id}_${safeName(m.name)}`;
      assetEntries.push([assetName, m.path]);
      return {
        origMediaId: m.id,
        type: m.type,
        name: m.name,
        scope: 'project',
        duration: m.duration,
        size: m.size,
        hash: m.hash,
        origFolderId: m.folder_id,
        assetName,
      };
    });

    for (const m of referencedCommon) addCommon(m);

    // Folder subset: full tree in full mode, else ancestors of packed media.
    const folders: FolderManifest[] = opts.fullProjectMedia
      ? payload.folders.map((f) => ({
          id: f.id,
          parentId: f.parent_id,
          name: f.name,
          position: f.position,
        }))
      : ancestorFolders(
          new Set(
            projectMedia
              .map((m) => m.folder_id)
              .filter((x): x is number => x != null)
          ),
          payload.folders
        );

    projects.push({
      name: payload.name,
      genCells: payload.genCells,
      templates: payload.templates,
      blocks: payload.blocks,
      media: mediaManifest,
      folders,
    });
  }

  if (opts.includeAllCommon) {
    const db = await getDb();
    const allCommon = await db.select<MediaRecord[]>(
      "SELECT * FROM media WHERE scope = 'common'"
    );
    for (const m of allCommon) addCommon(m);
  }

  const manifest: Manifest = {
    schemaVersion: 1,
    exportedAt: Date.now(),
    projects,
    commonMedia: [...commonMap.values()],
  };

  await invoke('export_bundle', {
    destPath,
    manifest: JSON.stringify(manifest),
    assets: assetEntries,
  });
}

// ============================================================================
// Import
// ============================================================================

export type ConflictStrategy = 'overwrite' | 'new' | 'skip';

export interface ImportOptions {
  // Decide what to do with a project whose name already exists. Called once per
  // project in the bundle; the UI may cache an "apply to all" answer. When the
  // name is NOT already present, `existing` is false and the caller normally
  // returns 'new' (import as-is) — 'overwrite' with no match falls back to new.
  resolveStrategy: (projectName: string, existing: boolean) => Promise<ConflictStrategy>;
}

export interface ImportSummary {
  imported: number;
  overwritten: number;
  skipped: number;
  projectNames: string[];
}

const rid = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const tslotId = (templateId: string, mediaId: number) => `tslot-${templateId}-${mediaId}`;
const bslotId = (blockId: string, mediaId: number) => `bslot-${blockId}-${mediaId}`;

interface MediaTarget {
  newId: number;
  newPath: string;
}

// Rewrite a stored Tiptap content string: remap mention media/slot ids and
// templateRef template ids; roleEntity ids (and templateRef.selectedRoleIds)
// are preserved verbatim so role bindings survive. Returns a new JSON string,
// or null for empty content.
function remapContent(
  content: string | null,
  mediaMap: Map<number, MediaTarget>,
  slotIdMap: Map<string, string>,
  templateIdMap: Map<string, string>
): string | null {
  if (!content) return null;
  let doc: JSONContent;
  try {
    doc = JSON.parse(content) as JSONContent;
  } catch {
    return content;
  }
  const walk = (node: JSONContent | undefined) => {
    if (!node) return;
    if (node.type === 'mention' && node.attrs) {
      const oldMid = node.attrs.mediaId as number | null | undefined;
      if (oldMid != null && mediaMap.has(oldMid)) {
        node.attrs.mediaId = mediaMap.get(oldMid)!.newId;
      }
      const oldSid = node.attrs.slotId as string | null | undefined;
      if (oldSid && slotIdMap.has(oldSid)) {
        node.attrs.slotId = slotIdMap.get(oldSid)!;
      }
    } else if (node.type === 'templateRef' && node.attrs) {
      const oldTid = node.attrs.templateId as string | null | undefined;
      if (oldTid && templateIdMap.has(oldTid)) {
        node.attrs.templateId = templateIdMap.get(oldTid)!;
      }
    }
    node.content?.forEach(walk);
  };
  walk(doc);
  return JSON.stringify(doc);
}

// Ensure a project name is unique among existing projects, appending " (n)".
function uniqueProjectName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} (${n})`)) n++;
  return `${base} (${n})`;
}

// Materialize one manifest media entry into a target bucket, returning its new
// id + path. Returns null when the backing asset is missing from the bundle.
async function materialize(
  m: MediaManifest,
  scope: 'project' | 'common',
  projectId: number | null,
  folderId: number | null,
  staged: string | undefined
): Promise<MediaTarget | null> {
  if (!staged) return null;
  const newPath = await invoke<string>('import_file', {
    scope,
    projectId,
    sourcePath: staged,
  });
  const newId = await insertMediaReturningId({
    project_id: projectId,
    type: m.type,
    name: m.name,
    path: newPath,
    duration: m.duration,
    size: m.size,
    thumb: m.type === 'image' ? newPath : null,
    hash: m.hash,
    scope,
    folder_id: folderId,
  });
  return { newId, newPath };
}

export async function importBundle(
  zipPath: string,
  opts: ImportOptions
): Promise<ImportSummary> {
  const raw = await invoke<string>('import_bundle', { zipPath });
  const parsed = JSON.parse(raw) as {
    manifest: Manifest;
    assets: Record<string, string>;
  };
  const manifest = parsed.manifest;
  const assets = parsed.assets;

  const db = await getDb();
  const summary: ImportSummary = {
    imported: 0,
    overwritten: 0,
    skipped: 0,
    projectNames: [],
  };

  // ---- 1. Common materials: import once, hash-dedup against the common lib.
  const commonIdMap = new Map<number, MediaTarget>();
  for (const cm of manifest.commonMedia ?? []) {
    // Reuse an existing common row with the same content hash.
    if (cm.hash) {
      const dupes = await db.select<MediaRecord[]>(
        "SELECT * FROM media WHERE scope = 'common' AND hash = ? LIMIT 1",
        [cm.hash]
      );
      if (dupes.length > 0) {
        const row = dupes[0];
        commonIdMap.set(cm.origMediaId, { newId: row.id, newPath: row.path });
        continue;
      }
    }
    const target = await materialize(cm, 'common', null, null, assets[cm.assetName]);
    if (target) commonIdMap.set(cm.origMediaId, target);
  }

  // ---- 2. Per-project import, honoring the conflict strategy.
  for (const p of manifest.projects) {
    const existingProjects = await listProjects();
    const match = existingProjects.find((x) => x.name === p.name);
    const strategy = await opts.resolveStrategy(p.name, !!match);
    if (strategy === 'skip') {
      summary.skipped++;
      continue;
    }

    let targetId: number;
    let overwrote = false;
    if (strategy === 'overwrite' && match) {
      targetId = match.id;
      await clearProjectMedia(targetId);
      overwrote = true;
    } else {
      const taken = new Set(existingProjects.map((x) => x.name));
      const name = uniqueProjectName(`${p.name} (导入)`, taken);
      const created = await createProject(name);
      targetId = created.id;
    }

    // 2a. Rebuild the folder subset parents-first.
    const folderIdMap = new Map<number, number>();
    const pending = [...p.folders];
    // Iterate until every folder whose parent is resolvable has been created.
    let guard = pending.length + 1;
    while (pending.length > 0 && guard-- > 0) {
      for (let i = pending.length - 1; i >= 0; i--) {
        const f = pending[i];
        const parentReady =
          f.parentId == null || folderIdMap.has(f.parentId);
        if (!parentReady) continue;
        const created = await createFolder({
          scope: 'project',
          projectId: targetId,
          parentId: f.parentId == null ? null : folderIdMap.get(f.parentId)!,
          name: f.name,
        });
        folderIdMap.set(f.id, created.id);
        pending.splice(i, 1);
      }
    }

    // 2b. Materialize project media, building the id map.
    const mediaMap = new Map<number, MediaTarget>(commonIdMap);
    for (const m of p.media) {
      const folderId =
        m.origFolderId != null ? folderIdMap.get(m.origFolderId) ?? null : null;
      const target = await materialize(
        m,
        'project',
        targetId,
        folderId,
        assets[m.assetName]
      );
      if (target) mediaMap.set(m.origMediaId, target);
    }

    // 2c. Remint container + slot ids, remap media, then rewrite content.
    const slotIdMap = new Map<string, string>();
    const templateIdMap = new Map<string, string>();

    // Gen cells (random slot ids).
    const genCells = p.genCells.map((c) => {
      const slots = c.slots
        .map((s) => {
          const mapped = mediaMap.get(s.media_id);
          if (!mapped) return null;
          const newSlotId = rid('slot');
          slotIdMap.set(s.id, newSlotId);
          return {
            id: newSlotId,
            media_id: mapped.newId,
            name: s.name,
            thumb: s.type === 'image' ? convertFileSrc(mapped.newPath) : s.thumb,
            path: mapped.newPath,
            meta: s.meta,
            type: s.type,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
      return { id: rid('cell'), note: c.note, slots };
    });

    // Templates (deterministic slot ids per new template + media).
    const templates = p.templates.map((t) => {
      const newTplId = rid('tpl');
      templateIdMap.set(t.id, newTplId);
      const slots = t.slots
        .map((s) => {
          const mapped = mediaMap.get(s.media_id);
          if (!mapped) return null;
          const newSlotId = tslotId(newTplId, mapped.newId);
          slotIdMap.set(s.id, newSlotId);
          return {
            id: newSlotId,
            media_id: mapped.newId,
            name: s.name,
            thumb: s.type === 'image' ? convertFileSrc(mapped.newPath) : s.thumb,
            path: mapped.newPath,
            meta: s.meta,
            type: s.type,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
      return {
        id: newTplId,
        name: t.name,
        content: t.content,
        referenceable: t.referenceable,
        includeTitle: t.includeTitle,
        slots,
      };
    });

    // Blocks (deterministic slot ids per new block + media).
    const blocks = p.blocks.map((b) => {
      const newBlkId = rid('blk');
      const slots = b.slots
        .map((s) => {
          const mapped = mediaMap.get(s.media_id);
          if (!mapped) return null;
          const newSlotId = bslotId(newBlkId, mapped.newId);
          slotIdMap.set(s.id, newSlotId);
          return {
            id: newSlotId,
            media_id: mapped.newId,
            name: s.name,
            thumb: s.type === 'image' ? convertFileSrc(mapped.newPath) : s.thumb,
            path: mapped.newPath,
            meta: s.meta,
            type: s.type,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
      return { id: newBlkId, content: b.content, combineEnabled: b.combineEnabled, slots };
    });

    // Now that every slot/template id is known, rewrite the content JSON.
    for (const c of genCells) {
      c.note = remapContent(c.note, mediaMap, slotIdMap, templateIdMap);
    }
    for (const t of templates) {
      t.content = remapContent(t.content, mediaMap, slotIdMap, templateIdMap);
    }
    for (const b of blocks) {
      b.content = remapContent(b.content, mediaMap, slotIdMap, templateIdMap);
    }

    // 2d. Full-rewrite the three areas (overwrite: replaces; new: fills).
    await saveGenCells(targetId, genCells);
    await saveTemplates(targetId, templates);
    await saveBlocks(targetId, blocks);

    if (overwrote) summary.overwritten++;
    else summary.imported++;
    summary.projectNames.push(p.name);
  }

  // ---- 3. Clean up the staging directory.
  const anyAsset = Object.values(assets)[0];
  if (anyAsset) {
    const dir = anyAsset.replace(/[\\/][^\\/]*$/, '');
    try {
      await invoke('cleanup_import_staging', { dir });
    } catch (err) {
      console.error('Failed to clean import staging', err);
    }
  }

  return summary;
}
