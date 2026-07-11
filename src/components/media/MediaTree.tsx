import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  Pencil,
  Trash2,
  Sparkles,
  Boxes,
  FolderOpen,
} from 'lucide-react';
import {
  listFolders,
  createFolder,
  renameFolder,
  deleteFolder,
  moveMedia,
  copyMedia,
  reorderFolders,
  type MediaFolderRecord,
  type ProjectRecord,
} from '../../lib/db';
import { useDrag } from '../../context/DragContext';

// A selected location in the material tree. `folder` targets a scope root or a
// nested folder; `ai` is the placeholder AI-generation node.
export type MediaSelection =
  | { kind: 'folder'; scope: 'project' | 'common'; projectId: number | null; folderId: number | null }
  | { kind: 'ai' };

export interface MediaTreeProps {
  // 'page' shows all three top nodes (项目 with a project list, 全局, AI生成).
  // 'panel' is scoped to a single project (its own folders, editable) plus the
  // global tree (read-only visible).
  mode: 'page' | 'panel';
  selection: MediaSelection;
  onSelect: (sel: MediaSelection) => void;
  // page mode: every project. panel mode: ignored.
  projects?: ProjectRecord[];
  // panel mode: the current project.
  currentProjectId?: number | null;
  // panel mode keeps the global (通用) subtree read-only (browse/drag only, no
  // folder create/rename/delete). Defaults to true (fully editable) for the page.
  commonEditable?: boolean;
  // Bumped by the parent to force a folder reload (e.g. after import).
  reloadKey?: number;
  // Called after a drag-drop relocation so the parent can refresh its media list.
  onMediaMoved?: () => void;
}

function sameFolder(a: MediaSelection, b: MediaSelection): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'ai' || b.kind === 'ai') return a.kind === b.kind;
  return a.scope === b.scope && a.projectId === b.projectId && a.folderId === b.folderId;
}

interface ContextMenuState {
  x: number;
  y: number;
  scope: 'project' | 'common';
  projectId: number | null;
  // The folder the menu was opened on; null = a scope/project root.
  folder: MediaFolderRecord | null;
}

export default function MediaTree({
  mode,
  selection,
  onSelect,
  projects = [],
  currentProjectId = null,
  commonEditable = true,
  reloadKey = 0,
  onMediaMoved,
}: MediaTreeProps) {
  const { subscribeDrop } = useDrag();
  const [commonFolders, setCommonFolders] = useState<MediaFolderRecord[]>([]);
  const [projectFolders, setProjectFolders] = useState<Record<number, MediaFolderRecord[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    'top:project': true,
    'top:common': true,
    'top:ai': false,
  });
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  // Track Shift so a drop can decide move (default) vs copy (Shift held).
  const shiftRef = useRef(false);
  // B6: folder drag-reorder state. `dragFolderId` is the folder being dragged;
  // `dropFolderId` is the sibling currently hovered as the insert target (used
  // only for a subtle highlight). Reordering is restricted to siblings sharing
  // the same scope/project/parent.
  const [dragFolderId, setDragFolderId] = useState<number | null>(null);
  const [dropFolderId, setDropFolderId] = useState<number | null>(null);

  // Which project ids' folders we need to load.
  const projectIds = useMemo<number[]>(() => {
    if (mode === 'panel') return currentProjectId != null ? [currentProjectId] : [];
    return projects.map((p) => p.id);
  }, [mode, currentProjectId, projects]);

  const loadCommon = useCallback(async () => {
    try {
      setCommonFolders(await listFolders('common'));
    } catch (err) {
      console.error('Failed to load common folders', err);
    }
  }, []);

  const loadProject = useCallback(async (pid: number) => {
    try {
      const rows = await listFolders('project', pid);
      setProjectFolders((prev) => ({ ...prev, [pid]: rows }));
    } catch (err) {
      console.error('Failed to load project folders', err);
    }
  }, []);

  // Reload the folder list for whichever scope a folder belongs to.
  const reloadScope = useCallback(
    async (folder: MediaFolderRecord) => {
      if (folder.scope === 'common') await loadCommon();
      else if (folder.project_id != null) await loadProject(folder.project_id);
    },
    [loadCommon, loadProject]
  );

  // B6: drop `dragFolderId` before `target` within its sibling group, then
  // persist the new order. `siblings` is the ordered children array the target
  // was rendered from; only same-group reorders are applied (cross-parent moves
  // stay the domain of the existing context menu / future move UI).
  const handleFolderReorder = useCallback(
    async (target: MediaFolderRecord, siblings: MediaFolderRecord[]) => {
      const draggedId = dragFolderId;
      setDragFolderId(null);
      setDropFolderId(null);
      if (draggedId == null || draggedId === target.id) return;
      const dragged = siblings.find((s) => s.id === draggedId);
      if (!dragged) return; // different sibling group — ignore
      const ids = siblings.map((s) => s.id).filter((id) => id !== draggedId);
      const at = ids.indexOf(target.id);
      if (at < 0) return;
      ids.splice(at, 0, draggedId);
      try {
        await reorderFolders(ids);
        await reloadScope(target);
      } catch (err) {
        console.error('Folder reorder failed', err);
      }
    },
    [dragFolderId, reloadScope]
  );

  useEffect(() => {
    loadCommon();
  }, [loadCommon, reloadKey]);

  useEffect(() => {
    projectIds.forEach((pid) => loadProject(pid));
  }, [projectIds, loadProject, reloadKey]);

  // Shift tracking for drop semantics.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Shift') shiftRef.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Shift') shiftRef.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // Drop target resolution: the DragContext delivers (payload, x, y) on release.
  // We resolve the folder node under the pointer via a data attribute and then
  // move (default) or copy (Shift) the material there.
  useEffect(() => {
    const unsub = subscribeDrop((payload, x, y) => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      const node = el?.closest('[data-drop-scope]') as HTMLElement | null;
      if (!node) return;
      const scope = node.dataset.dropScope as 'project' | 'common';
      const pidRaw = node.dataset.dropProject;
      const fidRaw = node.dataset.dropFolder;
      const projectId = pidRaw && pidRaw !== 'null' ? Number(pidRaw) : null;
      const folderId = fidRaw && fidRaw !== 'null' ? Number(fidRaw) : null;
      const copy = shiftRef.current;
      (async () => {
        try {
          // A multi-selection carries every dragged media in `items`; a single
          // drag falls back to the primary mediaId. Relocate each in turn.
          const ids =
            payload.items && payload.items.length > 0
              ? payload.items.map((it) => it.mediaId)
              : [payload.mediaId];
          for (const id of ids) {
            if (copy) {
              await copyMedia(id, { scope, projectId, folderId });
            } else {
              await moveMedia(id, { scope, projectId, folderId });
            }
          }
          onMediaMoved?.();
        } catch (err) {
          console.error('Drop relocation failed', err);
        }
      })();
    });
    return unsub;
  }, [subscribeDrop, onMediaMoved]);

  const toggle = (key: string) =>
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));

  const handleNewFolder = async (
    scope: 'project' | 'common',
    projectId: number | null,
    parentId: number | null
  ) => {
    const name = window.prompt('新建文件夹名称', '新建文件夹');
    if (!name || !name.trim()) return;
    try {
      await createFolder({ scope, projectId, parentId, name: name.trim() });
      if (scope === 'common') await loadCommon();
      else if (projectId != null) await loadProject(projectId);
      // Expand the parent so the new folder is visible.
      if (parentId != null) setExpanded((p) => ({ ...p, [`f:${parentId}`]: true }));
    } catch (err) {
      console.error('Create folder failed', err);
    }
  };

  const handleRename = async (folder: MediaFolderRecord) => {
    const name = window.prompt('重命名文件夹', folder.name);
    if (!name || !name.trim() || name.trim() === folder.name) return;
    try {
      await renameFolder(folder.id, name.trim());
      if (folder.scope === 'common') await loadCommon();
      else if (folder.project_id != null) await loadProject(folder.project_id);
    } catch (err) {
      console.error('Rename folder failed', err);
    }
  };

  const handleDelete = async (folder: MediaFolderRecord) => {
    const ok = window.confirm(
      `确定删除文件夹「${folder.name}」？其中的所有子文件夹与素材都会被一并删除，且不可恢复。`
    );
    if (!ok) return;
    try {
      await deleteFolder(folder.id);
      if (folder.scope === 'common') await loadCommon();
      else if (folder.project_id != null) await loadProject(folder.project_id);
      // If the deleted folder (or a descendant) was selected, fall back to root.
      if (selection.kind === 'folder' && selection.folderId != null) {
        onSelect({ kind: 'folder', scope: folder.scope, projectId: folder.project_id, folderId: null });
      }
      onMediaMoved?.();
    } catch (err) {
      console.error('Delete folder failed', err);
    }
  };

  // Recursively render folders of a given scope/project under a parent.
  const renderFolders = (
    all: MediaFolderRecord[],
    scope: 'project' | 'common',
    projectId: number | null,
    parentId: number | null,
    depth: number,
    editable: boolean
  ) => {
    const children = all.filter((f) => f.parent_id === parentId);
    return children.map((f) => {
      const key = `f:${f.id}`;
      const hasChildren = all.some((c) => c.parent_id === f.id);
      const isOpen = expanded[key] ?? false;
      const sel: MediaSelection = { kind: 'folder', scope, projectId, folderId: f.id };
      const active = sameFolder(selection, sel);
      return (
        <div key={key}>
          <div
            data-drop-scope={scope}
            data-drop-project={projectId == null ? 'null' : projectId}
            data-drop-folder={f.id}
            draggable={editable}
            onDragStart={(e) => {
              if (!editable) return;
              e.stopPropagation();
              e.dataTransfer.effectAllowed = 'move';
              // Some browsers require data to be set for dragging to start.
              e.dataTransfer.setData('text/plain', String(f.id));
              setDragFolderId(f.id);
            }}
            onDragOver={(e) => {
              // Only allow a drop indicator when reordering within this group.
              if (dragFolderId == null || dragFolderId === f.id) return;
              if (!children.some((c) => c.id === dragFolderId)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (dropFolderId !== f.id) setDropFolderId(f.id);
            }}
            onDragLeave={() => {
              if (dropFolderId === f.id) setDropFolderId(null);
            }}
            onDrop={(e) => {
              if (dragFolderId == null || dragFolderId === f.id) return;
              e.preventDefault();
              e.stopPropagation();
              void handleFolderReorder(f, children);
            }}
            onDragEnd={() => {
              setDragFolderId(null);
              setDropFolderId(null);
            }}
            onClick={() => onSelect(sel)}
            onContextMenu={(e) => {
              if (!editable) return;
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, scope, projectId, folder: f });
            }}
            style={{ paddingLeft: 8 + depth * 14 }}
            className={`group flex items-center gap-1 pr-2 py-1.5 text-[13px] cursor-pointer transition-colors ${
              active
                ? 'text-white bg-[#333333] border-l-2 border-[#2EC4B6]'
                : 'text-[#8A8A8A] hover:text-[#E5E5E5] hover:bg-[#2F2F2F] border-l-2 border-transparent'
            } ${dropFolderId === f.id ? 'ring-1 ring-inset ring-[#2EC4B6]' : ''}`}
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (hasChildren) toggle(key);
              }}
              className="flex items-center justify-center w-4 h-4 shrink-0"
            >
              {hasChildren ? (
                isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />
              ) : (
                <span className="w-[13px]" />
              )}
            </button>
            {isOpen ? <FolderOpen size={14} className="shrink-0" /> : <Folder size={14} className="shrink-0" />}
            <span className="flex-1 truncate">{f.name}</span>
          </div>
          {isOpen && renderFolders(all, scope, projectId, f.id, depth + 1, editable)}
        </div>
      );
    });
  };

  return (
    <div className="flex flex-col py-1 text-[#8A8A8A] select-none" onClick={() => menu && setMenu(null)}>
      {/* ── 项目 ── */}
      {mode === 'panel' && currentProjectId != null ? (
        (() => {
          const pid = currentProjectId;
          const isOpen = expanded['top:project'] ?? true;
          const folders = projectFolders[pid] ?? [];
          const sel: MediaSelection = { kind: 'folder', scope: 'project', projectId: pid, folderId: null };
          const active = sameFolder(selection, sel);
          return (
            <div>
              <div
                data-drop-scope="project"
                data-drop-project={pid}
                data-drop-folder="null"
                onClick={() => onSelect(sel)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, scope: 'project', projectId: pid, folder: null });
                }}
                className={`group flex items-center gap-1.5 px-2 py-1.5 text-[13px] cursor-pointer transition-colors border-l-2 ${
                  active
                    ? 'text-white bg-[#333333] border-[#2EC4B6]'
                    : 'text-[#2EC4B6] hover:bg-[#333333] border-transparent'
                }`}
              >
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle('top:project');
                  }}
                  className="flex items-center justify-center w-4 h-4 shrink-0"
                >
                  {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
                <Boxes size={14} />
                <span className="flex-1 truncate font-medium">项目</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleNewFolder('project', pid, null);
                  }}
                  title="新建文件夹"
                  className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-[#444444]"
                >
                  <FolderPlus size={13} />
                </button>
              </div>
              {isOpen && renderFolders(folders, 'project', pid, null, 1, true)}
            </div>
          );
        })()
      ) : (
        <>
          <button
            onClick={() => toggle('top:project')}
            className="flex items-center gap-1.5 px-2 py-1.5 text-[13px] text-[#2EC4B6] hover:bg-[#333333] transition-colors cursor-pointer"
          >
            {expanded['top:project'] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <Boxes size={14} />
            <span className="font-medium">项目</span>
          </button>
          {expanded['top:project'] && (
            <div>
              {projects.map((p) => {
                const pkey = `p:${p.id}`;
                const isOpen = expanded[pkey] ?? false;
                const folders = projectFolders[p.id] ?? [];
                const sel: MediaSelection = { kind: 'folder', scope: 'project', projectId: p.id, folderId: null };
                const active = sameFolder(selection, sel);
                return (
                  <div key={pkey}>
                    <div
                      data-drop-scope="project"
                      data-drop-project={p.id}
                      data-drop-folder="null"
                      onClick={() => onSelect(sel)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setMenu({ x: e.clientX, y: e.clientY, scope: 'project', projectId: p.id, folder: null });
                      }}
                      style={{ paddingLeft: 22 }}
                      className={`group flex items-center gap-1 pr-2 py-1.5 text-[13px] cursor-pointer transition-colors ${
                        active
                          ? 'text-white bg-[#333333] border-l-2 border-[#2EC4B6]'
                          : 'text-[#8A8A8A] hover:text-[#E5E5E5] hover:bg-[#2F2F2F] border-l-2 border-transparent'
                      }`}
                    >
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpanded((prev) => ({ ...prev, [pkey]: !isOpen }));
                        }}
                        className="flex items-center justify-center w-4 h-4 shrink-0"
                      >
                        {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      </button>
                      {isOpen ? <FolderOpen size={14} /> : <Folder size={14} />}
                      <span className="flex-1 truncate">{p.name}</span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleNewFolder('project', p.id, null);
                        }}
                        title="新建文件夹"
                        className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-[#444444]"
                      >
                        <FolderPlus size={13} />
                      </button>
                    </div>
                    {isOpen && renderFolders(folders, 'project', p.id, null, 2, true)}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* ── 全局（通用） ── */}
      {(() => {
        const commonSel: MediaSelection = {
          kind: 'folder',
          scope: 'common',
          projectId: null,
          folderId: null,
        };
        const commonActive = sameFolder(selection, commonSel);
        return (
          <div
            data-drop-scope="common"
            data-drop-project="null"
            data-drop-folder="null"
            onClick={() => onSelect(commonSel)}
            onContextMenu={
              commonEditable
                ? (e) => {
                    e.preventDefault();
                    setMenu({
                      x: e.clientX,
                      y: e.clientY,
                      scope: 'common',
                      projectId: null,
                      folder: null,
                    });
                  }
                : undefined
            }
            className={`group flex items-center gap-1.5 px-2 py-1.5 mt-0.5 text-[13px] cursor-pointer transition-colors ${
              commonActive
                ? 'text-white bg-[#333333]'
                : 'text-[#2EC4B6] hover:bg-[#333333]'
            }`}
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggle('top:common');
              }}
              className="flex items-center justify-center w-4 h-4 shrink-0"
            >
              {expanded['top:common'] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            <Boxes size={14} />
            <span className="flex-1 font-medium truncate">全局（通用）</span>
            {commonEditable && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleNewFolder('common', null, null);
                }}
                title="新建文件夹"
                className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-[#444444]"
              >
                <FolderPlus size={13} />
              </button>
            )}
          </div>
        );
      })()}
      {expanded['top:common'] && (
        <div>{renderFolders(commonFolders, 'common', null, null, 1, commonEditable)}</div>
      )}

      {/* ── AI 生成（占位） ── */}
      <button
        onClick={() => {
          toggle('top:ai');
          onSelect({ kind: 'ai' });
        }}
        className={`flex items-center gap-1.5 px-2 py-1.5 mt-0.5 text-[13px] transition-colors cursor-pointer ${
          selection.kind === 'ai' ? 'text-white bg-[#333333]' : 'text-[#2EC4B6] hover:bg-[#333333]'
        }`}
      >
        {expanded['top:ai'] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Sparkles size={14} />
        <span className="font-medium">AI 生成</span>
      </button>

      {/* Context menu */}
      {menu && (
        <div
          className="fixed z-[10000] min-w-[132px] rounded-md border border-[#3D3D3D] bg-[#252525] py-1 shadow-xl text-[13px]"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              handleNewFolder(menu.scope, menu.projectId, menu.folder?.id ?? null);
              setMenu(null);
            }}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[#E5E5E5] hover:bg-[#333333] cursor-pointer"
          >
            <FolderPlus size={14} /> 新建文件夹
          </button>
          {menu.folder && (
            <>
              <button
                onClick={() => {
                  handleRename(menu.folder!);
                  setMenu(null);
                }}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-[#E5E5E5] hover:bg-[#333333] cursor-pointer"
              >
                <Pencil size={14} /> 重命名
              </button>
              <button
                onClick={() => {
                  handleDelete(menu.folder!);
                  setMenu(null);
                }}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-[#E5735F] hover:bg-[#333333] cursor-pointer"
              >
                <Trash2 size={14} /> 删除
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
