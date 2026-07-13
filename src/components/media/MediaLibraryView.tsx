import { useCallback, useEffect, useState } from 'react';
import { open, message, ask } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useProject } from '../../context/ProjectContext';
import { useGenStore } from '../../context/GenStoreContext';
import { useGenTemplateStore } from '../../context/GenTemplateStoreContext';
import { useBlockStore } from '../../context/BlockStoreContext';
import { useMediaRevision } from '../../context/MediaRevisionContext';
import { importMediaFile } from '../../lib/db';
import MediaTree, { type MediaSelection } from './MediaTree';
import MediaToolbar, { type MediaTab, type SortKey, type SortDir } from './MediaToolbar';
import MediaContent from './MediaContent';

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'];
const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'];
const VIDEO_EXT = ['mp4', 'mov', 'mkv', 'avi', 'webm', 'flv', 'm4v'];

function typeFromPath(path: string): MediaTab | null {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  if (VIDEO_EXT.includes(ext)) return 'video';
  return null;
}

// The single implementation of the material-library UI (tree + toolbar +
// content grid + import + drag-relocate). Both the standalone MediaLibraryPage
// and the in-project MediaLibraryPanel render this so their behavior is
// guaranteed identical.
//
// - mode='page': shows every project plus the fully-editable global tree.
// - mode='panel': scoped to the current project (editable) plus the global tree
//   as read-only-visible; the whole thing lives inside the project's left dock.
export default function MediaLibraryView({ mode }: { mode: 'page' | 'panel' }) {
  const { projects, activeProjectId } = useProject();
  const { renameMedia } = useGenStore();
  const { renameMedia: renameMediaTpl } = useGenTemplateStore();
  const { renameMedia: renameMediaBlk } = useBlockStore();
  const { bump: bumpMediaRev } = useMediaRevision();

  // Panel defaults its selection to the current project root; page defaults to
  // the global root.
  const [selection, setSelection] = useState<MediaSelection>(() =>
    mode === 'panel' && activeProjectId != null
      ? { kind: 'folder', scope: 'project', projectId: activeProjectId, folderId: null }
      : { kind: 'folder', scope: 'common', projectId: null, folderId: null }
  );
  const [activeTab, setActiveTab] = useState<MediaTab>('image');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [search, setSearch] = useState('');
  // B1: front-end sort + extension filter for the material grid/list.
  const [sortKey, setSortKey] = useState<SortKey>('time');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [filterExt, setFilterExt] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [dragOver, setDragOver] = useState(false);

  // Bump both the local reloadKey (refreshes this view's tree + content) and
  // the app-wide media revision (refreshes the gen-area @ image pools).
  const bump = useCallback(() => {
    setReloadKey((n) => n + 1);
    bumpMediaRev();
  }, [bumpMediaRev]);

  // In the panel, follow project switches: re-point selection at the newly
  // active project's root (only while a project scope is selected, so a user
  // browsing the global tree isn't yanked away).
  useEffect(() => {
    if (mode !== 'panel' || activeProjectId == null) return;
    setSelection((prev) =>
      prev.kind === 'folder' && prev.scope === 'project'
        ? { kind: 'folder', scope: 'project', projectId: activeProjectId, folderId: null }
        : prev
    );
  }, [mode, activeProjectId]);

  // B1: switching media tab clears an extension filter that only applies to the
  // previous tab's file types (each tab has its own EXT_OPTIONS set).
  useEffect(() => {
    setFilterExt(null);
  }, [activeTab]);

  const handleRenamed = useCallback(
    (id: number, name: string) => {
      renameMedia(id, name);
      renameMediaTpl(id, name);
      renameMediaBlk(id, name);
      bumpMediaRev();
    },
    [renameMedia, renameMediaTpl, renameMediaBlk, bumpMediaRev]
  );

  const importPaths = useCallback(
    async (paths: string[]) => {
      if (selection.kind !== 'folder' || paths.length === 0) return;
      try {
        // First video import: ffmpeg is needed for video covers + HEVC preview.
        // If it isn't available yet, offer a one-click auto-download. The import
        // proceeds either way (without ffmpeg, videos just lack cover/preview).
        const hasVideo = paths.some((p) => typeFromPath(p) === 'video');
        if (hasVideo) {
          try {
            const status = await invoke<{ available: boolean }>('ffmpeg_status');
            if (!status.available) {
              const yes = await ask(
                '首次导入视频需要 ffmpeg 来生成封面并支持 HEVC/H.265 视频预览。是否现在自动下载？（约几十 MB，仅需一次）',
                { title: '需要 ffmpeg', kind: 'info', okLabel: '自动下载', cancelLabel: '暂不' }
              );
              if (yes) {
                try {
                  await invoke<string>('download_ffmpeg');
                  void message('ffmpeg 已就绪。', { title: '下载完成', kind: 'info' });
                } catch (err) {
                  console.error('download_ffmpeg failed', err);
                  void message(
                    '自动下载 ffmpeg 失败，视频将暂时缺少封面与 HEVC 预览。你可稍后重试导入。',
                    { title: '下载失败', kind: 'warning' }
                  );
                }
              }
            }
          } catch (err) {
            console.error('ffmpeg_status check failed', err);
          }
        }
        // B2: track skipped duplicates to notify the user afterwards.
        const skipped: string[] = [];
        let imported = 0;
        for (const path of paths) {
          const t = typeFromPath(path);
          if (!t) {
            console.warn('Unsupported file type, skipped:', path);
            continue;
          }
          const res = await importMediaFile({
            scope: selection.scope,
            projectId: selection.projectId,
            folderId: selection.folderId,
            sourcePath: path,
            type: t,
          });
          if (res.duplicate) skipped.push(res.name);
          else imported += 1;
        }
        if (imported > 0) bump();
        if (skipped.length > 0) {
          // Non-blocking notice; duplicates were skipped (not re-inserted).
          const list = skipped.slice(0, 5).join('、');
          const more = skipped.length > 5 ? ` 等 ${skipped.length} 个` : '';
          void message(
            `以下素材已存在，已跳过：${list}${more}`,
            { title: '导入去重', kind: 'info' }
          );
        }
      } catch (err) {
        console.error('Import failed', err);
      }
    },
    [selection, bump]
  );

  const handleImport = useCallback(async () => {
    if (selection.kind !== 'folder') return;
    try {
      const filters =
        activeTab === 'image'
          ? [{ name: '图片', extensions: IMAGE_EXT }]
          : activeTab === 'audio'
          ? [{ name: '音频', extensions: AUDIO_EXT }]
          : [{ name: '视频', extensions: VIDEO_EXT }];
      const selected = await open({ multiple: true, filters });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      await importPaths(paths);
    } catch (err) {
      console.error('Failed to open file picker', err);
    }
  }, [selection, activeTab, importPaths]);

  // OS file drag-drop (Tauri native — the only path that yields real file
  // paths). Drops import into the currently-selected scope/folder.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        unlisten = await getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === 'over' || payload.type === 'enter') setDragOver(true);
          else if (payload.type === 'leave') setDragOver(false);
          else if (payload.type === 'drop') {
            setDragOver(false);
            const paths = (payload as { paths?: string[] }).paths ?? [];
            if (paths.length > 0) importPaths(paths);
          }
        });
      } catch (err) {
        console.error('Failed to register drag-drop listener', err);
      }
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, [importPaths]);

  const dropHint = mode === 'panel' ? '松开以导入到当前所选位置' : '松开以导入到当前所选位置';
  const treeWidth = mode === 'panel' ? 150 : 220;

  return (
    <div
      className={`relative flex flex-1 min-h-0 overflow-hidden transition-shadow ${
        dragOver ? 'ring-2 ring-inset ring-[#2EC4B6]' : ''
      }`}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-[#2EC4B6]/10 text-[#2EC4B6] text-[14px] font-medium">
          {dropHint}
        </div>
      )}
      {/* Left tree */}
      <div
        className="shrink-0 border-r border-[#3D3D3D] overflow-y-auto scrollbar-dark"
        style={{ width: treeWidth, minWidth: treeWidth }}
      >
        <MediaTree
          mode={mode}
          selection={selection}
          onSelect={setSelection}
          projects={projects}
          currentProjectId={activeProjectId}
          commonEditable={mode === 'page'}
          reloadKey={reloadKey}
          onMediaMoved={bump}
        />
      </div>

      {/* Right content */}
      <div className="flex-1 flex flex-col min-w-0">
        <MediaToolbar
          activeTab={activeTab}
          onTabChange={setActiveTab}
          viewMode={viewMode}
          onToggleView={() => setViewMode((v) => (v === 'grid' ? 'list' : 'grid'))}
          sortKey={sortKey}
          sortDir={sortDir}
          onSortChange={(k, d) => {
            setSortKey(k);
            setSortDir(d);
          }}
          filterExt={filterExt}
          onFilterChange={setFilterExt}
          search={search}
          onSearch={setSearch}
          onImport={handleImport}
          importDisabled={selection.kind !== 'folder'}
        />
        <MediaContent
          selection={selection}
          activeTab={activeTab}
          viewMode={viewMode}
          search={search}
          sortKey={sortKey}
          sortDir={sortDir}
          filterExt={filterExt}
          reloadKey={reloadKey}
          onRenamed={handleRenamed}
          emptyHint="暂无素材，点击右上角 ＋ 导入"
        />
      </div>
    </div>
  );
}
