import { useCallback, useEffect, useRef, useState } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { confirm } from '@tauri-apps/plugin-dialog';
import { Clock, Grid3X3, Play, Pause, Music, Sparkles as SfxIcon } from 'lucide-react';
import {
  listMedia,
  deleteMedia,
  updateMediaName,
  type MediaRecord,
} from '../../lib/db';
import { useDrag, type DragPayload, type DragItem } from '../../context/DragContext';
import { useMediaRevision } from '../../context/MediaRevisionContext';
import EditableName from './EditableName';
import type { MediaSelection } from './MediaTree';
import type { MediaTab, SortKey, SortDir } from './MediaToolbar';

export interface MediaContentHandle {
  reload: () => void;
}

interface MediaContentProps {
  selection: MediaSelection;
  activeTab: MediaTab;
  viewMode: 'grid' | 'list';
  search: string;
  // B1: front-end sort + extension filter (derived from the loaded records).
  sortKey?: SortKey;
  sortDir?: SortDir;
  filterExt?: string | null;
  reloadKey?: number;
  // Sync callbacks so renaming a material also updates any slot references
  // that display its name (gen / template / block stores).
  onRenamed?: (id: number, name: string) => void;
  emptyHint?: string;
}

export default function MediaContent({
  selection,
  activeTab,
  viewMode,
  search,
  sortKey = 'time',
  sortDir = 'desc',
  filterExt = null,
  reloadKey = 0,
  onRenamed,
  emptyHint = '暂无素材',
}: MediaContentProps) {
  const { beginDrag } = useDrag();
  const { bump: bumpMediaRev } = useMediaRevision();
  const [records, setRecords] = useState<MediaRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [lastClicked, setLastClicked] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [preview, setPreview] = useState<MediaRecord | null>(null);
  const dragSuppressClick = useRef(false);
  // B4: audio preview — one shared <audio> element; `playingId` is the record
  // currently playing (null = nothing playing). Toggling the same row pauses;
  // toggling another switches source.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingId, setPlayingId] = useState<number | null>(null);

  const toggleAudio = useCallback((rec: MediaRecord) => {
    let el = audioRef.current;
    if (!el) {
      el = new Audio();
      el.onended = () => setPlayingId(null);
      audioRef.current = el;
    }
    if (playingId === rec.id) {
      el.pause();
      setPlayingId(null);
      return;
    }
    try {
      el.src = convertFileSrc(rec.path);
      void el.play();
      setPlayingId(rec.id);
    } catch (err) {
      console.error('Audio playback failed', err);
      setPlayingId(null);
    }
  }, [playingId]);

  // Stop playback + release the element on unmount.
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = '';
        audioRef.current = null;
      }
    };
  }, []);

  // Stop audio when the folder/tab changes (records reload).
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.pause();
    }
    setPlayingId(null);
  }, [selection, activeTab]);

  const load = useCallback(async () => {
    setSelected(new Set());
    setLastClicked(null);
    if (selection.kind !== 'folder') {
      setRecords([]);
      return;
    }
    setLoading(true);
    try {
      const rows = await listMedia({
        scope: selection.scope,
        projectId: selection.projectId,
        folderId: selection.folderId,
        type: activeTab,
      });
      setRecords(rows);
    } catch (err) {
      console.error('Failed to load media', err);
      setRecords([]);
    } finally {
      setLoading(false);
    }
  }, [selection, activeTab]);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
    };
  }, [menu]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || !!target?.isContentEditable;
      if (e.code === 'Space' && !inInput) {
        if (preview) {
          e.preventDefault();
          setPreview(null);
          return;
        }
        if (selected.size === 1 && (activeTab === 'image' || activeTab === 'video')) {
          const id = Array.from(selected)[0];
          const rec = records.find((r) => r.id === id);
          if (rec) {
            e.preventDefault();
            setPreview(rec);
          }
        }
      } else if (e.key === 'Escape' && preview) {
        setPreview(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, activeTab, records, preview]);

  const handleRename = async (id: number, newName: string) => {
    if (!newName.trim()) {
      setEditingId(null);
      return;
    }
    try {
      await updateMediaName(id, newName.trim());
      onRenamed?.(id, newName.trim());
      setRecords((prev) => prev.map((r) => (r.id === id ? { ...r, name: newName.trim() } : r)));
    } catch (err) {
      console.error('Rename failed', err);
    }
    setEditingId(null);
  };

  const handleCardPointerDown = (e: React.PointerEvent, item: MediaRecord) => {
    if (e.button !== 0) return;
    const toDragItem = (r: MediaRecord): DragItem => ({
      mediaId: r.id,
      name: r.name,
      thumb: r.thumb ? convertFileSrc(r.thumb) : '',
      path: r.path,
      meta: r.duration ?? r.size ?? '',
      type: activeTab,
    });
    // If the pressed card is part of a multi-selection, drag the WHOLE
    // selection (ordered by the visible list). Pressing a card that is not
    // in the current selection drags just that one (selection is unchanged
    // here; the click handler resets it on release if it was a plain click).
    const multi = selected.has(item.id) && selected.size > 1;
    const items: DragItem[] = multi
      ? filtered.filter((r) => selected.has(r.id)).map(toDragItem)
      : [toDragItem(item)];
    const primary = toDragItem(item);
    const payload: DragPayload = { ...primary, items };
    const startX = e.clientX;
    const startY = e.clientY;
    const THRESHOLD = 4;
    const onMove = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) >= THRESHOLD) {
        cleanup();
        dragSuppressClick.current = true;
        beginDrag(payload, ev.clientX, ev.clientY);
      }
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', cleanup);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', cleanup);
  };

  const handleCardClick = (e: React.MouseEvent, id: number) => {
    if (dragSuppressClick.current) {
      dragSuppressClick.current = false;
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setLastClicked(id);
      return;
    }
    if (e.shiftKey && lastClicked != null) {
      const ids = filtered.map((r) => r.id);
      const a = ids.indexOf(lastClicked);
      const b = ids.indexOf(id);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSelected(new Set(ids.slice(lo, hi + 1)));
        return;
      }
    }
    setSelected(new Set([id]));
    setLastClicked(id);
  };

  const handleContextMenu = (e: React.MouseEvent, id: number) => {
    e.preventDefault();
    e.stopPropagation();
    setSelected((prev) => (prev.has(id) ? prev : new Set([id])));
    setLastClicked((prev) => (selected.has(id) ? prev : id));
    setMenu({ x: e.clientX, y: e.clientY });
  };

  const handleDeleteSelected = async () => {
    const ids = Array.from(selected);
    setMenu(null);
    if (ids.length === 0) return;
    // Destructive: confirm before removing rows + physical files.
    const ok = await confirm(
      ids.length > 1
        ? `确定删除选中的 ${ids.length} 个素材？此操作会同时删除本地文件，无法撤销。`
        : '确定删除该素材？此操作会同时删除本地文件，无法撤销。',
      { title: '删除素材', kind: 'warning' }
    );
    if (!ok) return;
    try {
      for (const id of ids) await deleteMedia(id);
    } catch (err) {
      console.error('Delete failed', err);
    }
    setSelected(new Set());
    setLastClicked(null);
    load();
    bumpMediaRev();
  };

  const handleRenameSelected = () => {
    const ids = Array.from(selected);
    setMenu(null);
    if (ids.length === 1) setEditingId(ids[0]);
  };

  // A6: reveal the (single) selected material in the OS file manager.
  const handleRevealSelected = async () => {
    const ids = Array.from(selected);
    setMenu(null);
    if (ids.length !== 1) return;
    const rec = records.find((r) => r.id === ids[0]);
    if (!rec?.path) return;
    try {
      await invoke('reveal_in_explorer', { path: rec.path });
    } catch (err) {
      console.error('Reveal failed', err);
    }
  };

  // A6: open the (single) selected material with the OS default application.
  const handleOpenSelected = async () => {
    const ids = Array.from(selected);
    setMenu(null);
    if (ids.length !== 1) return;
    const rec = records.find((r) => r.id === ids[0]);
    if (!rec?.path) return;
    try {
      await invoke('open_path', { path: rec.path });
    } catch (err) {
      console.error('Open failed', err);
    }
  };

  // A6: copy the selected material file(s) to the system clipboard.
  const handleCopyFilesSelected = async () => {
    const ids = Array.from(selected);
    setMenu(null);
    if (ids.length === 0) return;
    const paths = ids
      .map((id) => records.find((r) => r.id === id)?.path)
      .filter((p): p is string => !!p);
    if (paths.length === 0) return;
    try {
      await invoke('copy_files_to_clipboard', { paths });
    } catch (err) {
      console.error('Copy files failed', err);
    }
  };

  // B1: derive the visible list = search filter + extension filter + sort.
  // Purely front-end (does not touch listMedia's query/signature).
  const extOf = (r: MediaRecord): string =>
    (r.name.split('.').pop() ?? '').toLowerCase();
  const filtered = (() => {
    let rows = records;
    const q = search.trim().toLowerCase();
    if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q));
    if (filterExt) {
      const want = filterExt.toLowerCase();
      // Treat jpg/jpeg as interchangeable for the image "jpg"/"jpeg" options.
      rows = rows.filter((r) => {
        const e = extOf(r);
        return e === want || (want === 'jpg' && e === 'jpeg') || (want === 'jpeg' && e === 'jpg');
      });
    }
    const dir = sortDir === 'asc' ? 1 : -1;
    const sorted = [...rows].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'name') {
        cmp = a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true });
      } else if (sortKey === 'type') {
        // Group by file extension, then by name for a stable secondary order.
        cmp = extOf(a).localeCompare(extOf(b)) || a.name.localeCompare(b.name);
      } else {
        // 'time' = created_at; fall back to id order when timestamps tie.
        cmp = a.created_at.localeCompare(b.created_at) || a.id - b.id;
      }
      return cmp * dir;
    });
    return sorted;
  })();

  const thumbSrc = (r: MediaRecord) => (r.thumb ? convertFileSrc(r.thumb) : '/tiger-cover.jpg');

  if (selection.kind === 'ai') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-[#555555]">
        <SfxIcon size={32} strokeWidth={1.5} />
        <span className="text-[13px]">AI 生成素材（即将上线）</span>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-5 scrollbar-dark">
      {loading && filtered.length === 0 && (
        <div className="flex items-center justify-center h-full text-[#555555] text-[13px]">加载中...</div>
      )}
      {!loading && filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center h-full gap-3 text-[#555555]">
          <Grid3X3 size={32} strokeWidth={1.5} />
          <span className="text-[13px]">{emptyHint}</span>
        </div>
      )}

      {filtered.length > 0 && (activeTab === 'image' || activeTab === 'video') && (
        <div className={viewMode === 'grid' ? 'grid grid-cols-[repeat(auto-fill,minmax(min(50%_-_6px,150px),1fr))] gap-3' : 'flex flex-col gap-2'}>
          {filtered.map((item) => (
            <div
              key={item.id}
              onPointerDown={(e) => handleCardPointerDown(e, item)}
              onClick={(e) => handleCardClick(e, item.id)}
              onContextMenu={(e) => handleContextMenu(e, item.id)}
              className={`group relative text-left rounded-md overflow-hidden transition-all duration-200 cursor-grab active:cursor-grabbing ${
                viewMode === 'grid' ? '' : 'flex items-center gap-3 p-2 hover:bg-[#333333]'
              } ${selected.has(item.id) ? 'ring-2 ring-[#2EC4B6]' : ''}`}
            >
              {viewMode === 'grid' ? (
                <>
                  <div className="relative aspect-video bg-[#333333] overflow-hidden rounded-md">
                    <img
                      src={thumbSrc(item)}
                      alt={item.name}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                    />
                    {activeTab === 'video' && (
                      <>
                        <div className="absolute bottom-1.5 right-1.5 px-1 py-0.5 bg-black/60 text-white text-[11px] rounded backdrop-blur-sm flex items-center gap-0.5">
                          <Clock size={10} />
                          {item.duration ?? '00:00'}
                        </div>
                        <div className="absolute inset-0 bg-black/30 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                          <div className="w-8 h-8 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
                            <Play size={16} className="text-white ml-0.5" fill="white" />
                          </div>
                        </div>
                      </>
                    )}
                    {activeTab === 'image' && item.size && (
                      <div className="absolute bottom-1.5 right-1.5 px-1 py-0.5 bg-black/60 text-white text-[11px] rounded backdrop-blur-sm">
                        {item.size}
                      </div>
                    )}
                  </div>
                  <div className="mt-1.5 px-0.5">
                    <EditableName
                      name={item.name}
                      isEditing={editingId === item.id}
                      onStartEdit={() => setEditingId(item.id)}
                      onConfirm={(newName) => handleRename(item.id, newName)}
                      onCancel={() => setEditingId(null)}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="relative w-16 h-10 bg-[#333333] rounded overflow-hidden shrink-0">
                    <img src={thumbSrc(item)} alt={item.name} className="w-full h-full object-cover" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <EditableName
                      name={item.name}
                      isEditing={editingId === item.id}
                      onStartEdit={() => setEditingId(item.id)}
                      onConfirm={(newName) => handleRename(item.id, newName)}
                      onCancel={() => setEditingId(null)}
                      textClass="text-[13px] text-[#E5E5E5]"
                    />
                    <div className="text-[11px] text-[#8A8A8A]">
                      {activeTab === 'video' ? item.duration ?? '00:00' : item.size ?? '—'}
                    </div>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {filtered.length > 0 && activeTab === 'audio' && (
        <div className="flex flex-col gap-2">
          {filtered.map((item) => (
            <div
              key={item.id}
              onPointerDown={(e) => handleCardPointerDown(e, item)}
              onClick={(e) => handleCardClick(e, item.id)}
              onContextMenu={(e) => handleContextMenu(e, item.id)}
              className={`flex items-center gap-3 p-3 rounded-md transition-all duration-200 cursor-grab active:cursor-grabbing text-left ${
                selected.has(item.id) ? 'bg-[#333333] ring-1 ring-[#2EC4B6]' : 'hover:bg-[#333333]'
              }`}
            >
              <div className="w-10 h-10 rounded-md flex items-center justify-center shrink-0 bg-[#2EC4B6]/20">
                <Music size={18} className="text-[#2EC4B6]" />
              </div>
              <div className="flex-1 min-w-0">
                <EditableName
                  name={item.name}
                  isEditing={editingId === item.id}
                  onStartEdit={() => setEditingId(item.id)}
                  onConfirm={(newName) => handleRename(item.id, newName)}
                  onCancel={() => setEditingId(null)}
                  textClass="text-[13px] text-[#E5E5E5]"
                />
                <div className="text-[11px] text-[#8A8A8A]">{item.duration ?? '00:00'}</div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toggleAudio(item);
                }}
                onPointerDown={(e) => e.stopPropagation()}
                title={playingId === item.id ? '暂停' : '播放'}
                className="p-1.5 rounded hover:bg-[#444444] transition-colors cursor-pointer shrink-0"
              >
                {playingId === item.id ? (
                  <Pause size={14} className="text-[#2EC4B6]" />
                ) : (
                  <Play size={14} className="text-[#8A8A8A]" />
                )}
              </button>
            </div>
          ))}
        </div>
      )}

      {menu && (
        <div
          className="fixed z-50 min-w-[120px] py-1 rounded-md bg-[#2A2A2A] border border-[#3A3A3A] shadow-lg text-[13px] text-[#E5E5E5]"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {selected.size === 1 && (
            <button
              className="w-full px-3 py-1.5 text-left hover:bg-[#333333] cursor-pointer"
              onClick={handleRenameSelected}
            >
              重命名
            </button>
          )}
          {selected.size === 1 && (
            <button
              className="w-full px-3 py-1.5 text-left hover:bg-[#333333] cursor-pointer"
              onClick={handleOpenSelected}
            >
              打开
            </button>
          )}
          {selected.size === 1 && (
            <button
              className="w-full px-3 py-1.5 text-left hover:bg-[#333333] cursor-pointer"
              onClick={handleRevealSelected}
            >
              打开文件位置
            </button>
          )}
          <button
            className="w-full px-3 py-1.5 text-left hover:bg-[#333333] cursor-pointer"
            onClick={handleCopyFilesSelected}
          >
            复制文件{selected.size > 1 ? ` (${selected.size})` : ''}
          </button>
          <button
            className="w-full px-3 py-1.5 text-left hover:bg-[#333333] text-[#E5484D] cursor-pointer"
            onClick={handleDeleteSelected}
          >
            删除{selected.size > 1 ? ` (${selected.size})` : ''}
          </button>
        </div>
      )}

      {preview && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center"
          onClick={() => setPreview(null)}
        >
          {activeTab === 'video' ? (
            <video
              src={convertFileSrc(preview.path)}
              className="max-w-[90vw] max-h-[90vh]"
              controls
              autoPlay
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <img
              src={convertFileSrc(preview.path)}
              alt={preview.name}
              className="max-w-[90vw] max-h-[90vh] object-contain"
              onClick={(e) => e.stopPropagation()}
            />
          )}
        </div>
      )}
    </div>
  );
}
