import { useState, useRef, useEffect, useCallback } from 'react';
import { Plus, Pencil, Trash2, FolderOpen, Film, Check, Download, Upload } from 'lucide-react';
import { open as openDialog, save as saveDialog, message } from '@tauri-apps/plugin-dialog';
import { useProject } from '../context/ProjectContext';
import { exportBundle, importBundle, type ConflictStrategy } from '../lib/bundle';
import type { ProjectRecord } from '../lib/db';

function ProjectCard({
  project,
  onOpen,
  onRename,
  onDelete,
  selectable = false,
  selected = false,
  onToggleSelect,
}: {
  project: ProjectRecord;
  onOpen: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const updated = new Date(project.updated_at.replace(' ', 'T') + 'Z');
  const updatedLabel = isNaN(updated.getTime())
    ? project.updated_at
    : updated.toLocaleString();

  // In selection mode a single click toggles selection instead of opening.
  const handleCardClick = selectable ? onToggleSelect : onOpen;

  return (
    <div
      onDoubleClick={selectable ? undefined : onOpen}
      className={`group relative flex flex-col rounded-xl border bg-[#252525] overflow-hidden transition-colors cursor-pointer ${
        selectable && selected
          ? 'border-[#2EC4B6]'
          : 'border-[#3D3D3D] hover:border-[#2EC4B6]/60'
      }`}
    >
      <div
        onClick={handleCardClick}
        className="relative aspect-video bg-[#1E1E1E] flex items-center justify-center overflow-hidden"
      >
        {project.cover ? (
          <img src={project.cover} alt={project.name} className="w-full h-full object-cover" />
        ) : (
          <Film size={40} strokeWidth={1.2} className="text-[#3D3D3D]" />
        )}
        {selectable && (
          <div
            className={`absolute top-2 left-2 w-5 h-5 rounded-md flex items-center justify-center border ${
              selected
                ? 'bg-[#2EC4B6] border-[#2EC4B6] text-white'
                : 'bg-[#1E1E1E]/70 border-[#8A8A8A]'
            }`}
          >
            {selected && <Check size={13} strokeWidth={3} />}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          {editing && !selectable ? (
            <input
              ref={inputRef}
              defaultValue={project.name}
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => {
                onRename(e.target.value);
                setEditing(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  onRename(e.currentTarget.value);
                  setEditing(false);
                }
                if (e.key === 'Escape') setEditing(false);
              }}
              className="w-full bg-[#1E1E1E] text-[#E5E5E5] text-[13px] px-1.5 py-0.5 rounded outline-none ring-1 ring-[#2EC4B6]"
            />
          ) : (
            <>
              <div className="text-[13px] text-[#E5E5E5] font-medium truncate">{project.name}</div>
              <div className="text-[11px] text-[#8A8A8A] truncate">{updatedLabel}</div>
            </>
          )}
        </div>

        {!selectable && (
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          <button
            title="打开"
            onClick={(e) => { e.stopPropagation(); onOpen(); }}
            className="p-1.5 rounded text-[#8A8A8A] hover:text-[#2EC4B6] hover:bg-[#333333] transition-colors"
          >
            <FolderOpen size={13} />
          </button>
          <button
            title="重命名"
            onClick={(e) => { e.stopPropagation(); setEditing(true); }}
            className="p-1.5 rounded text-[#8A8A8A] hover:text-[#E5E5E5] hover:bg-[#333333] transition-colors"
          >
            <Pencil size={13} />
          </button>
          <button
            title="删除"
            onClick={(e) => { e.stopPropagation(); setConfirmDelete(true); }}
            className="p-1.5 rounded text-[#8A8A8A] hover:text-red-400 hover:bg-[#333333] transition-colors"
          >
            <Trash2 size={13} />
          </button>
          </div>
        )}
      </div>

      {confirmDelete && !selectable && (
        <div
          className="absolute inset-0 bg-[#1E1E1E]/95 flex flex-col items-center justify-center gap-3 p-4"
          onClick={(e) => e.stopPropagation()}
        >
          <span className="text-[13px] text-[#E5E5E5] text-center">删除「{project.name}」及其全部素材？</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setConfirmDelete(false); onDelete(); }}
              className="px-3 py-1.5 rounded-md bg-red-500 hover:bg-red-600 text-white text-[12px] transition-colors"
            >
              删除
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="px-3 py-1.5 rounded-md bg-[#333333] hover:bg-[#444444] text-[#E5E5E5] text-[12px] transition-colors"
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// A pending conflict prompt: the importer is asking what to do with a project
// whose name already exists. `resolve` continues the import with the choice.
interface ConflictPrompt {
  name: string;
  resolve: (choice: { strategy: ConflictStrategy; applyAll: boolean }) => void;
}

export default function Home() {
  const {
    projects,
    loading,
    openProject,
    createProject,
    renameProject,
    deleteProject,
    refreshProjects,
    reloadActiveProject,
  } = useProject();

  // Batch-export selection mode.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [includeAllCommon, setIncludeAllCommon] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<ConflictPrompt | null>(null);

  const toggleSelect = useCallback((id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const exitSelectMode = useCallback(() => {
    setSelecting(false);
    setSelected(new Set());
    setIncludeAllCommon(false);
  }, []);

  const handleBatchExport = useCallback(async () => {
    if (selected.size === 0) return;
    const ids = projects.filter((p) => selected.has(p.id)).map((p) => p.id);
    try {
      const dest = await saveDialog({
        title: '批量导出项目',
        defaultPath: `项目导出_${ids.length}个.zip`,
        filters: [{ name: 'Promptly 项目包', extensions: ['zip'] }],
      });
      if (!dest) return;
      setBusy(true);
      await exportBundle(dest, ids, {
        fullProjectMedia: false,
        includeAllCommon,
      });
      await message('导出完成', { title: 'Promptly', kind: 'info' });
      exitSelectMode();
    } catch (err) {
      console.error('Batch export failed', err);
      await message(`导出失败：${err}`, { title: 'Promptly', kind: 'error' });
    } finally {
      setBusy(false);
    }
  }, [selected, projects, includeAllCommon, exitSelectMode]);

  const handleImport = useCallback(async () => {
    try {
      const picked = await openDialog({
        title: '导入项目',
        multiple: false,
        filters: [{ name: 'Promptly 项目包', extensions: ['zip'] }],
      });
      if (!picked || Array.isArray(picked)) return;
      setBusy(true);
      // Cached "apply to all" choice for the whole import run.
      let applyAllChoice: ConflictStrategy | null = null;
      const summary = await importBundle(picked, {
        resolveStrategy: (name, existing) =>
          new Promise((resolve) => {
            // No name clash -> import as a new project silently.
            if (!existing) {
              resolve('new');
              return;
            }
            if (applyAllChoice) {
              resolve(applyAllChoice);
              return;
            }
            setConflict({
              name,
              resolve: ({ strategy, applyAll }) => {
                if (applyAll) applyAllChoice = strategy;
                setConflict(null);
                resolve(strategy);
              },
            });
          }),
      });
      await refreshProjects();
      reloadActiveProject();
      await message(
        `导入完成：新增 ${summary.imported}，覆盖 ${summary.overwritten}，跳过 ${summary.skipped}`,
        { title: 'Promptly', kind: 'info' }
      );
    } catch (err) {
      console.error('Import failed', err);
      await message(`导入失败：${err}`, { title: 'Promptly', kind: 'error' });
    } finally {
      setBusy(false);
    }
  }, [refreshProjects, reloadActiveProject]);

  return (
    <div className="h-full w-full overflow-y-auto scrollbar-dark bg-[#1E1E1E] px-8 py-8">
      <div className="max-w-[1200px] mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-[22px] text-[#E5E5E5] font-semibold">我的项目</h1>
            <p className="text-[13px] text-[#8A8A8A] mt-1">选择一个项目继续，或新建一个项目</p>
          </div>
          {selecting ? (
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-[12px] text-[#B5B5B5] cursor-pointer select-none mr-1">
                <input
                  type="checkbox"
                  checked={includeAllCommon}
                  onChange={(e) => setIncludeAllCommon(e.target.checked)}
                  className="accent-[#2EC4B6]"
                />
                包含全部通用素材
              </label>
              <button
                onClick={() => void handleBatchExport()}
                disabled={selected.size === 0 || busy}
                className={`flex items-center gap-1.5 px-4 h-9 rounded-lg text-white text-[13px] font-medium transition-colors ${
                  selected.size === 0 || busy
                    ? 'bg-[#2EC4B6]/50 cursor-default'
                    : 'bg-[#2EC4B6] hover:bg-[#25A99C] cursor-pointer'
                }`}
              >
                <Download size={15} />
                <span>{busy ? '导出中…' : `导出选中 (${selected.size})`}</span>
              </button>
              <button
                onClick={exitSelectMode}
                className="flex items-center gap-1.5 px-4 h-9 rounded-lg bg-[#333333] hover:bg-[#444444] text-[#E5E5E5] text-[13px] transition-colors cursor-pointer"
              >
                取消
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setSelecting(true)}
                disabled={projects.length === 0}
                className={`flex items-center gap-1.5 px-4 h-9 rounded-lg text-[13px] transition-colors ${
                  projects.length === 0
                    ? 'bg-[#242424] text-[#666666] cursor-default'
                    : 'bg-[#2A2A2A] hover:bg-[#333333] text-[#E5E5E5] cursor-pointer'
                }`}
              >
                <Download size={15} />
                <span>批量导出</span>
              </button>
              <button
                onClick={() => void handleImport()}
                disabled={busy}
                className="flex items-center gap-1.5 px-4 h-9 rounded-lg bg-[#2A2A2A] hover:bg-[#333333] text-[#E5E5E5] text-[13px] transition-colors cursor-pointer"
              >
                <Upload size={15} />
                <span>{busy ? '导入中…' : '导入项目'}</span>
              </button>
              <button
                onClick={() => createProject()}
                className="flex items-center gap-1.5 px-4 h-9 rounded-lg bg-[#2EC4B6] hover:bg-[#25A99C] text-white text-[13px] font-medium transition-colors cursor-pointer"
              >
                <Plus size={15} strokeWidth={2.5} />
                <span>新建项目</span>
              </button>
            </div>
          )}
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-[300px] text-[#555555] text-[14px]">加载中...</div>
        ) : projects.length === 0 ? (
          <button
            onClick={() => createProject()}
            className="flex flex-col items-center justify-center gap-3 w-full h-[320px] rounded-xl border border-dashed border-[#3D3D3D] text-[#555555] hover:border-[#2EC4B6]/60 hover:text-[#2EC4B6] transition-colors cursor-pointer"
          >
            <Plus size={40} strokeWidth={1.2} />
            <span className="text-[14px]">还没有项目，点击新建第一个项目</span>
          </button>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
            {!selecting && (
              <button
                onClick={() => createProject()}
                className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[#3D3D3D] text-[#555555] hover:border-[#2EC4B6]/60 hover:text-[#2EC4B6] transition-colors cursor-pointer aspect-[4/3.4]"
              >
                <Plus size={30} strokeWidth={1.2} />
                <span className="text-[13px]">新建项目</span>
              </button>
            )}
            {projects.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                onOpen={() => openProject(p.id)}
                onRename={(name) => renameProject(p.id, name)}
                onDelete={() => deleteProject(p.id)}
                selectable={selecting}
                selected={selected.has(p.id)}
                onToggleSelect={() => toggleSelect(p.id)}
              />
            ))}
          </div>
        )}
      </div>

      {conflict && (
        <ConflictModal
          name={conflict.name}
          onChoose={(strategy, applyAll) =>
            conflict.resolve({ strategy, applyAll })
          }
        />
      )}
    </div>
  );
}

// Modal shown per name-clashing project during import: overwrite / save-new /
// skip, with an "apply to all" toggle. Overwrite is destructive so it is styled
// as the warning action and its description spells out the consequence.
function ConflictModal({
  name,
  onChoose,
}: {
  name: string;
  onChoose: (strategy: ConflictStrategy, applyAll: boolean) => void;
}) {
  const [applyAll, setApplyAll] = useState(false);
  return (
    <div className="fixed inset-0 z-[10000] bg-black/60 flex items-center justify-center p-6">
      <div className="w-[420px] rounded-xl border border-[#3D3D3D] bg-[#252525] p-5 shadow-2xl">
        <div className="text-[15px] text-[#E5E5E5] font-medium mb-1">名称冲突</div>
        <div className="text-[13px] text-[#B5B5B5] mb-4">
          已存在同名项目「{name}」，请选择处理方式：
        </div>
        <div className="flex flex-col gap-2">
          <button
            onClick={() => onChoose('overwrite', applyAll)}
            className="w-full text-left px-3 py-2.5 rounded-lg border border-red-500/40 bg-red-500/10 hover:bg-red-500/20 transition-colors cursor-pointer"
          >
            <div className="text-[13px] text-red-300 font-medium">覆盖现有项目</div>
            <div className="text-[11px] text-[#8A8A8A]">清空该项目的素材库与生图/模板/分镜后重建</div>
          </button>
          <button
            onClick={() => onChoose('new', applyAll)}
            className="w-full text-left px-3 py-2.5 rounded-lg border border-[#3D3D3D] bg-[#2A2A2A] hover:bg-[#333333] transition-colors cursor-pointer"
          >
            <div className="text-[13px] text-[#E5E5E5] font-medium">另存为新项目</div>
            <div className="text-[11px] text-[#8A8A8A]">导入为「{name} (导入)」，原项目不变</div>
          </button>
          <button
            onClick={() => onChoose('skip', applyAll)}
            className="w-full text-left px-3 py-2.5 rounded-lg border border-[#3D3D3D] bg-[#2A2A2A] hover:bg-[#333333] transition-colors cursor-pointer"
          >
            <div className="text-[13px] text-[#E5E5E5] font-medium">跳过</div>
            <div className="text-[11px] text-[#8A8A8A]">不导入此项目</div>
          </button>
        </div>
        <label className="flex items-center gap-1.5 text-[12px] text-[#B5B5B5] cursor-pointer select-none mt-4">
          <input
            type="checkbox"
            checked={applyAll}
            onChange={(e) => setApplyAll(e.target.checked)}
            className="accent-[#2EC4B6]"
          />
          对后续所有冲突应用相同选择
        </label>
      </div>
    </div>
  );
}
