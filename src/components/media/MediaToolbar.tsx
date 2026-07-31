import { useState, useRef, useEffect } from 'react';
import {
  Image,
  Music,
  Video,
  Search,
  Plus,
  LayoutGrid,
  List,
  ArrowUpDown,
  SlidersHorizontal,
  Check,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';

export type MediaTab = 'image' | 'audio' | 'video';

// B1: how the material list is ordered. 'time' = import time (created_at),
// 'name' = file name, 'type' = media type. Direction toggles asc/desc.
export type SortKey = 'time' | 'name' | 'type';
export type SortDir = 'asc' | 'desc';

export interface MediaToolbarProps {
  activeTab: MediaTab;
  onTabChange: (tab: MediaTab) => void;
  viewMode: 'grid' | 'list';
  onToggleView: () => void;
  // B1: sort + filter wiring (front-end derived list).
  sortKey?: SortKey;
  sortDir?: SortDir;
  onSortChange?: (key: SortKey, dir: SortDir) => void;
  filterExt?: string | null;
  onFilterChange?: (ext: string | null) => void;
  search: string;
  onSearch: (value: string) => void;
  onImport: () => void;
  importDisabled?: boolean;
}

const TABS: { key: MediaTab; label: string; icon: typeof Image }[] = [
  { key: 'image', label: '图片', icon: Image },
  { key: 'audio', label: '音频', icon: Music },
  { key: 'video', label: '视频', icon: Video },
];

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'time', label: '按时间' },
  { key: 'name', label: '按名称' },
  { key: 'type', label: '按类型' },
];

// File-extension filter options per media type (类型筛选). "全部" clears it.
const EXT_OPTIONS: Record<MediaTab, string[]> = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'],
  audio: ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'],
  video: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'flv', 'm4v'],
};

// Shared toolbar for the material library. Renders the tab row (tabs on the
// left, an icon-only action group on the right) plus a full-width search row
// below it. Reused by both the standalone MediaLibraryPage and the in-project
// MediaLibraryPanel so their behavior stays identical.
export default function MediaToolbar({
  activeTab,
  onTabChange,
  viewMode,
  onToggleView,
  sortKey = 'time',
  sortDir = 'desc',
  onSortChange,
  filterExt = null,
  onFilterChange,
  search,
  onSearch,
  onImport,
  importDisabled,
}: MediaToolbarProps) {
  const [sortOpen, setSortOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const sortWrapRef = useRef<HTMLDivElement>(null);
  const filterWrapRef = useRef<HTMLDivElement>(null);

  // Close either dropdown on an outside click.
  useEffect(() => {
    if (!sortOpen && !filterOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (sortOpen && sortWrapRef.current && !sortWrapRef.current.contains(t)) {
        setSortOpen(false);
      }
      if (filterOpen && filterWrapRef.current && !filterWrapRef.current.contains(t)) {
        setFilterOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [sortOpen, filterOpen]);

  const pickSort = (key: SortKey) => {
    // Re-picking the active key flips direction; a new key starts descending.
    const dir: SortDir = key === sortKey ? (sortDir === 'asc' ? 'desc' : 'asc') : 'desc';
    onSortChange?.(key, dir);
    setSortOpen(false);
  };

  const exts = EXT_OPTIONS[activeTab];

  return (
    <div className="shrink-0 border-b border-[#3D3D3D] bg-[#2A2A2A]">
      {/* Tab row: tabs left, icon actions right */}
      <div className="flex items-center justify-between px-4 py-2">
        <div className="flex items-center gap-1">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => onTabChange(tab.key)}
                title={tab.label}
                className={`flex items-center justify-center px-3 py-2 rounded-md transition-all duration-200 cursor-pointer ${
                  isActive
                    ? 'text-[#2EC4B6] font-medium'
                    : 'text-[#8A8A8A] hover:text-[#E5E5E5] hover:bg-[#333333]'
                }`}
              >
                <Icon size={18} strokeWidth={isActive ? 2 : 1.5} />
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={onImport}
            disabled={importDisabled}
            title="导入"
            className="flex items-center justify-center w-8 h-8 bg-[#2EC4B6] text-white rounded-lg hover:bg-[#25A99C] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus size={16} strokeWidth={2.5} />
          </button>
          <button
            onClick={onToggleView}
            title={viewMode === 'grid' ? '切换为列表' : '切换为网格'}
            className="flex items-center justify-center w-8 h-8 bg-[#1E1E1E] text-[#8A8A8A] rounded-lg hover:text-[#E5E5E5] transition-colors cursor-pointer"
          >
            {viewMode === 'grid' ? <List size={15} /> : <LayoutGrid size={15} />}
          </button>

          {/* Sort dropdown */}
          <div ref={sortWrapRef} className="relative">
            <button
              onClick={() => {
                setSortOpen((v) => !v);
                setFilterOpen(false);
              }}
              title="排序"
              className={`flex items-center justify-center w-8 h-8 bg-[#1E1E1E] rounded-lg transition-colors cursor-pointer ${
                sortOpen ? 'text-[#2EC4B6]' : 'text-[#8A8A8A] hover:text-[#E5E5E5]'
              }`}
            >
              <ArrowUpDown size={14} />
            </button>
            {sortOpen && (
              <div className="absolute right-0 mt-1 z-50 min-w-[132px] py-1 rounded-md bg-[#2A2A2A] border border-[#3A3A3A] shadow-lg text-[13px] text-[#E5E5E5]">
                {SORT_OPTIONS.map((opt) => (
                  <button
                    key={opt.key}
                    onClick={() => pickSort(opt.key)}
                    className="flex items-center justify-between w-full px-3 py-1.5 text-left hover:bg-[#333333] cursor-pointer"
                  >
                    <span className={opt.key === sortKey ? 'text-[#2EC4B6]' : ''}>{opt.label}</span>
                    {opt.key === sortKey &&
                      (sortDir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Filter (by file extension) dropdown */}
          <div ref={filterWrapRef} className="relative">
            <button
              onClick={() => {
                setFilterOpen((v) => !v);
                setSortOpen(false);
              }}
              title="筛选"
              className={`flex items-center justify-center w-8 h-8 bg-[#1E1E1E] rounded-lg transition-colors cursor-pointer ${
                filterExt || filterOpen ? 'text-[#2EC4B6]' : 'text-[#8A8A8A] hover:text-[#E5E5E5]'
              }`}
            >
              <SlidersHorizontal size={14} />
            </button>
            {filterOpen && (
              <div className="absolute right-0 mt-1 z-50 min-w-[132px] max-h-[240px] overflow-y-auto scrollbar-dark py-1 rounded-md bg-[#2A2A2A] border border-[#3A3A3A] shadow-lg text-[13px] text-[#E5E5E5]">
                <button
                  onClick={() => {
                    onFilterChange?.(null);
                    setFilterOpen(false);
                  }}
                  className="flex items-center justify-between w-full px-3 py-1.5 text-left hover:bg-[#333333] cursor-pointer"
                >
                  <span className={filterExt == null ? 'text-[#2EC4B6]' : ''}>全部类型</span>
                  {filterExt == null && <Check size={12} />}
                </button>
                {exts.map((ext) => (
                  <button
                    key={ext}
                    onClick={() => {
                      onFilterChange?.(ext);
                      setFilterOpen(false);
                    }}
                    className="flex items-center justify-between w-full px-3 py-1.5 text-left hover:bg-[#333333] cursor-pointer"
                  >
                    <span className={filterExt === ext ? 'text-[#2EC4B6]' : ''}>
                      .{ext}
                    </span>
                    {filterExt === ext && <Check size={12} />}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      {/* Search row: full width */}
      <div className="px-4 pb-3">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#666666]" />
          <input
            type="text"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="搜索文件名称、画面元素、台词"
            className="w-full h-8 bg-[#1E1E1E] text-[#E5E5E5] text-[13px] pl-9 pr-4 rounded-lg outline-none placeholder:text-[#666666] focus:ring-1 focus:ring-[#2EC4B6]/50 transition-all"
          />
        </div>
      </div>
    </div>
  );
}
