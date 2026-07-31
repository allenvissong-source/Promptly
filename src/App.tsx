import { useState, useRef, useCallback, useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { confirm, save as saveDialog, message } from '@tauri-apps/plugin-dialog';
import { ProjectProvider, useProject } from './context/ProjectContext';
import logoUrl from './assets/logo.png';
import { DragProvider } from './context/DragContext';
import { GenSettingsProvider, useGenSettings } from './context/GenSettingsContext';
import { ActiveEditorProvider } from './context/ActiveEditorContext';
import { GenStoreProvider, useGenStore } from './context/GenStoreContext';
import { GenTemplateStoreProvider, useGenTemplateStore } from './context/GenTemplateStoreContext';
import { BlockStoreProvider, useBlockStore } from './context/BlockStoreContext';
import { HistoryProvider, useHistory } from './context/HistoryContext';
import { MediaRevisionProvider } from './context/MediaRevisionContext';
import {
  PanelLayoutProvider,
  usePanelLayout,
  type HSizes,
  type VSizes,
  type PanelKey,
} from './context/PanelLayoutContext';
import { mergeAllPrompts } from './components/gen/serializePrompt';
import { expandTemplateRef } from './components/gen/roleUtils';
import { exportBundle } from './lib/bundle';
import {
  copyRichText,
  exportFormatRulesFromSettings,
  type ClipboardCopyStatus,
} from './lib/richClipboard';
import type { GenImageItem } from './context/GenImagesContext';
import type { ChipMode } from './context/GenSettingsContext';
import type { ResolvedTemplateRef } from './components/gen/GenPromptEditor';
import GenArea from './components/gen/GenArea';
import TemplateArea from './components/gen/TemplateArea';
import StoryboardArea from './components/gen/StoryboardArea';
import Home from './pages/Home';
import MediaLibraryPage from './pages/MediaLibraryPage';
import MediaLibraryView from './components/media/MediaLibraryView';
import SettingsModal from './components/settings/SettingsModal';
import {
  Plus,
  X,
  Home as HomeIcon,
  Check,
  FolderOpen,
  Minus,
  Square,
  ClipboardCopy,
  ChevronDown,
  LayoutGrid,
  RotateCcw,
  Settings,
} from 'lucide-react';

// Platform detection via the webview UA. On macOS the window keeps its
// native chrome (rounded corners, shadow, traffic lights) through
// titleBarStyle: "Overlay" (see src-tauri/src/lib.rs), so the in-app
// window controls are hidden and the toolbar leaves room for the traffic
// lights. Windows / Linux keep the borderless custom chrome.
const IS_MAC = /Macintosh|Mac OS X/.test(navigator.userAgent);

// ============================================
// Resizable Layout
// ============================================
type Orientation = 'horizontal' | 'vertical';

interface DragState {
  active: boolean;
  orientation: Orientation;
  // horizontal: the two adjacent VISIBLE column logical indices being resized.
  // vertical: leftIndex = 0 (media/gen split); rightIndex unused.
  leftIndex: number;
  rightIndex: number;
  startPos: number;
  startValue: number;
  containerSize: number;
  // Sum of the visible columns' canonical widths, used to map a pixel delta
  // (over the on-screen track) back into canonical (all-3) width space.
  visibleRaw: number;
}

// Visibility-aware three-column layout. Column widths / row heights live in
// PanelLayoutContext (persisted). hSizes are kept in canonical "all three
// columns" space so a hidden column remembers its width; the on-screen track
// only renders the visible columns, normalized to fill 100%.
function ResizableLayout({
  children,
  gap = 2,
  padding = 2,
}: {
  children: React.ReactNode[];
  gap?: number;
  padding?: number;
}) {
  const { visible, hSizes, vSizes, setHSizes, setVSizes } = usePanelLayout();
  const [drag, setDrag] = useState<DragState | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const hMin = [24, 18, 15];
  const hMax = [55, 65, 45];
  const vMin = [25, 15];
  const vMax = [75, 75];

  // Logical columns: 0 = left (media/gen stack), 1 = middle (template),
  // 2 = right (storyboard). The left column shows whenever media OR gen is on.
  const leftVisible = visible.media || visible.gen;
  const cols: number[] = [];
  if (leftVisible) cols.push(0);
  if (visible.template) cols.push(1);
  if (visible.storyboard) cols.push(2);
  const sumVisibleRaw = cols.reduce((s, i) => s + hSizes[i], 0) || 1;
  const share = (i: number) => (hSizes[i] / sumVisibleRaw) * 100;

  const handleMouseDown = useCallback(
    (
      e: React.MouseEvent,
      orientation: Orientation,
      leftIndex: number,
      rightIndex: number,
      visibleRaw: number
    ) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const containerSize =
        orientation === 'horizontal'
          ? rect.width - padding * 2
          : rect.height - padding * 2;
      const startPos =
        orientation === 'horizontal'
          ? e.clientX - rect.left - padding
          : e.clientY - rect.top - padding;
      const startValue =
        orientation === 'horizontal' ? hSizes[leftIndex] : vSizes[leftIndex];
      setDrag({
        active: true,
        orientation,
        leftIndex,
        rightIndex,
        startPos,
        startValue,
        containerSize,
        visibleRaw,
      });
    },
    [hSizes, vSizes, padding]
  );

  useEffect(() => {
    if (!drag?.active) return;

    const handleMouseMove = (e: MouseEvent) => {
      const {
        orientation,
        leftIndex,
        rightIndex,
        startPos,
        startValue,
        containerSize,
        visibleRaw,
      } = drag;
      const currentPos = orientation === 'horizontal' ? e.clientX : e.clientY;
      const deltaPx = currentPos - startPos;

      if (orientation === 'horizontal') {
        // Map pixel delta (over the visible track) into canonical width space.
        const deltaPct = (deltaPx / containerSize) * visibleRaw;
        const newValue = startValue + deltaPct;
        const pairTotal = hSizes[leftIndex] + hSizes[rightIndex];

        let clamped = Math.max(
          hMin[leftIndex],
          Math.min(hMax[leftIndex], newValue)
        );
        const minLeft = Math.max(hMin[leftIndex], pairTotal - hMax[rightIndex]);
        const maxLeft = Math.min(hMax[leftIndex], pairTotal - hMin[rightIndex]);
        clamped = Math.max(minLeft, Math.min(maxLeft, clamped));

        const newLeft = clamped;
        const newRight = pairTotal - newLeft;

        setHSizes((prev) => {
          const next: HSizes = [prev[0], prev[1], prev[2]];
          next[leftIndex] = newLeft;
          next[rightIndex] = newRight;
          return next;
        });
      } else {
        const index = leftIndex; // 0 = media (top)
        const otherIndex = index === 0 ? 1 : 0;
        const deltaPct = (deltaPx / containerSize) * 100;
        let newValue = startValue + deltaPct;
        const min = vMin[index];
        const max = vMax[index];
        const effectiveMax = 100 - vMin[otherIndex];
        const effectiveMin = 100 - vMax[otherIndex];
        newValue = Math.max(Math.min(newValue, max, effectiveMax), min, effectiveMin);

        setVSizes((prev) => {
          const next: VSizes = [prev[0], prev[1]];
          next[index] = newValue;
          next[otherIndex] = 100 - newValue;
          return next;
        });
      }
    };

    const handleMouseUp = () => setDrag(null);

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [drag, setHSizes, setVSizes]);

  // Render one logical column's cell content.
  const renderColumn = (i: number): React.ReactNode => {
    if (i === 0) {
      const both = visible.media && visible.gen;
      if (both) {
        return (
          <div
            key="col-left"
            className="grid min-h-0 min-w-0"
            style={{
              gridTemplateColumns: '100%',
              gridTemplateRows: `${vSizes[0]}% ${gap}px ${vSizes[1]}%`,
              gap: 0,
            }}
          >
            <div className="min-h-0 min-w-0">{children[0]}</div>
            <div
              className="z-20 bg-[#3D3D3D] hover:bg-[#2EC4B6] transition-colors cursor-row-resize"
              onMouseDown={(e) => handleMouseDown(e, 'vertical', 0, 1, 100)}
            />
            <div className="min-h-0 min-w-0">{children[1]}</div>
          </div>
        );
      }
      // Only one of media/gen visible -> it fills the whole left column.
      return (
        <div key="col-left" className="min-h-0 min-w-0">
          {visible.media ? children[0] : children[1]}
        </div>
      );
    }
    if (i === 1) return <div key="col-mid" className="min-h-0 min-w-0">{children[2]}</div>;
    return <div key="col-right" className="min-h-0 min-w-0">{children[3]}</div>;
  };

  // Build the outer grid: visible columns interleaved with drag handles.
  const templateParts: string[] = [];
  const nodes: React.ReactNode[] = [];
  cols.forEach((ci, idx) => {
    if (idx > 0) {
      const leftCol = cols[idx - 1];
      const rightCol = ci;
      templateParts.push(`${gap}px`);
      nodes.push(
        <div
          key={`h-${leftCol}-${rightCol}`}
          className="z-10 bg-[#3D3D3D] hover:bg-[#2EC4B6] transition-colors cursor-col-resize"
          onMouseDown={(e) =>
            handleMouseDown(e, 'horizontal', leftCol, rightCol, sumVisibleRaw)
          }
        />
      );
    }
    templateParts.push(`${share(ci)}%`);
    nodes.push(renderColumn(ci));
  });

  return (
    <div
      ref={containerRef}
      className="grid w-full h-full overflow-hidden bg-[#1E1E1E]"
      style={{
        padding,
        gridTemplateColumns: templateParts.join(' '),
        gridTemplateRows: '100%',
        gap: 0,
      }}
    >
      {nodes}
    </div>
  );
}

// ============================================
// Media Library Panel
// ============================================
function MediaLibraryPanel() {
  // The in-project left dock now renders the shared MediaLibraryView in
  // 'panel' mode: the current project's folder tree (editable) plus the
  // global (通用) tree as read-only-visible, the shared icon toolbar, and
  // the shared content grid. Same component that backs the standalone 素材库 page.
  return (
    <div className="flex flex-col h-full w-full bg-[#2A2A2A] rounded-sm overflow-hidden">
      <MediaLibraryView mode="panel" />
    </div>
  );
}

// ============================================
// Top Bar
// ============================================
// 自绘品牌 Logo：胶片 / 播放三角，青绿渐变
function AppLogo({ dotColor = '#E5E5E5' }: { dotColor?: string }) {
  return (
    <div className="flex items-center gap-2 shrink-0 pl-0.5" title={"Promptly · 普罗"}>
      <img
        src={logoUrl}
        alt="Promptly"
        className="w-[26px] h-[26px] shrink-0 rounded-lg select-none"
        draggable={false}
      />
      <span className="text-[13px] font-semibold text-[#E5E5E5] tracking-tight whitespace-nowrap">
        Promptly<span style={{ color: dotColor, transition: 'color 0.2s ease' }}>・</span>普罗
      </span>
    </div>
  );
}

function TopBar() {
  return <TopBarInner />;
}

// Global switch for how @ chips render across the app: derived "Image序号"
// (code) vs. the material file name (name). Neither keeps the "@" prefix.
function ChipModeToggle() {
  const { chipMode, toggleChipMode } = useGenSettings();
  return <ChipModeToggleInner chipMode={chipMode} toggleChipMode={toggleChipMode} />;
}

// Custom window controls (minimize / maximize-toggle / close) that live in the
// toolbar row. Only used on Windows / Linux, where the window is borderless
// (decorations: false). On macOS the native traffic lights provide these
// actions instead (see IS_MAC and src-tauri/src/lib.rs).
// `onRequestClose` routes the close button through the unsaved-changes guard.
function WindowControls({ onRequestClose }: { onRequestClose: () => void }) {
  const win = getCurrentWindow();
  return (
    <div className="flex items-center gap-1 shrink-0 pl-1">
      <button
        onClick={() => void win.minimize()}
        title="缩小"
        className="flex items-center justify-center w-8 h-8 rounded-lg text-[#8A8A8A] hover:bg-[#333333] hover:text-[#E5E5E5] transition-colors cursor-pointer"
      >
        <Minus size={14} />
      </button>
      <button
        onClick={() => void win.toggleMaximize()}
        title="全屏"
        className="flex items-center justify-center w-8 h-8 rounded-lg text-[#8A8A8A] hover:bg-[#333333] hover:text-[#E5E5E5] transition-colors cursor-pointer"
      >
        <Square size={12} />
      </button>
      <button
        onClick={onRequestClose}
        title="关闭"
        className="flex items-center justify-center w-8 h-8 rounded-lg text-[#8A8A8A] hover:bg-[#E53935] hover:text-white transition-colors cursor-pointer"
      >
        <X size={15} />
      </button>
    </div>
  );
}

function ChipModeToggleInner({
  chipMode,
  toggleChipMode,
}: {
  chipMode: ReturnType<typeof useGenSettings>['chipMode'];
  toggleChipMode: ReturnType<typeof useGenSettings>['toggleChipMode'];
}) {
  return (
    <button
      onClick={toggleChipMode}
      title="切换 @ 引用显示：编号 / 文件名"
      className="flex items-center gap-1.5 px-3 h-8 rounded-lg bg-[#2A2A2A] hover:bg-[#333333] text-[#E5E5E5] text-[12px] transition-colors cursor-pointer"
    >
      <span>{chipMode === 'code' ? '显示：编号' : '显示：文件名'}</span>
    </button>
  );
}

function TopBarInner() {
  const {
    projects,
    openTabs,
    activeProjectId,
    view,
    goHome,
    goLibrary,
    openProject,
    closeTab,
    createProject,
    renameProject,
  } = useProject();
  const { cells, dirty: genDirty, save: saveGen } = useGenStore();
  const { templates, dirty: tplDirty, save: saveTpl } = useGenTemplateStore();
  const { blocks, dirty: blkDirty, save: saveBlk } = useBlockStore();
  const genSettings = useGenSettings();
  const { chipMode, activeStorageSpaceId, copyAsTableCell } = genSettings;
  const exportFormatRules = exportFormatRulesFromSettings(genSettings);
  const { undo, redo } = useHistory();
  const dirty = genDirty || tplDirty || blkDirty;
  const save = useCallback(async () => {
    await Promise.all([saveGen(), saveTpl(), saveBlk()]);
  }, [saveGen, saveTpl, saveBlk]);

  // A5: 复制全部 — merge every 生图/模板/分镜 card into one plain-text blob
  // (current chipMode) and write it to the clipboard. Blocks resolve their
  // @template refs against the live template list, exactly as each block's own
  // copy button does (expandTemplateRef).
  const [copiedAll, setCopiedAll] = useState<ClipboardCopyStatus | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const resolveTemplateRef = useCallback(
    (
      templateId: string,
      selectedRoleIds: string[],
      blockImages: GenImageItem[],
      mode: ChipMode
    ): ResolvedTemplateRef | null => {
      const t = templates.find((x) => x.id === templateId);
      if (!t) return null;
      return expandTemplateRef(
        { name: t.name, includeTitle: t.includeTitle, content: t.content },
        selectedRoleIds,
        blockImages,
        mode
      );
    },
    [templates]
  );
  const handleCopyAll = useCallback(async () => {
    const serialized = mergeAllPrompts(
      cells.map((c) => ({ images: c.images, note: c.note })),
      templates.map((t) => ({
        name: t.name,
        includeTitle: t.includeTitle,
        content: t.content,
        images: t.images,
      })),
      blocks.map((b) => ({ content: b.content, images: b.images })),
      chipMode,
      resolveTemplateRef
    );
    const result = await copyRichText(serialized.plainText, exportFormatRules, { 
      tableCell: copyAsTableCell,
      initialStyles: serialized.styles,
    });
    setCopiedAll(result.status);
    setTimeout(() => setCopiedAll(null), 1500);
  }, [cells, templates, blocks, chipMode, resolveTemplateRef, exportFormatRules, copyAsTableCell]);

  // Export the active project to a single self-contained .zip. `fullMedia`
  // controls the material scope: false = 仅打包被引用的素材 (default), true =
  // 本项目全部素材. Common materials are always limited to referenced ones here
  // (全部通用素材 is a Home-only batch-export option).
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!exportMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!exportMenuRef.current?.contains(e.target as Node)) {
        setExportMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [exportMenuOpen]);

  const handleExport = useCallback(
    async (fullMedia: boolean) => {
      setExportMenuOpen(false);
      if (activeProjectId == null) return;
      const proj = projects.find((p) => p.id === activeProjectId);
      const baseName = (proj?.name || '项目').replace(/[\\/:*?"<>|]/g, '_');
      try {
        const dest = await saveDialog({
          title: '导出项目',
          defaultPath: `${baseName}.zip`,
          filters: [{ name: 'Promptly 项目包', extensions: ['zip'] }],
        });
        if (!dest) return;
        setExporting(true);
        await exportBundle(dest, [activeProjectId], {
          fullProjectMedia: fullMedia,
          includeAllCommon: false,
        });
        await message('导出完成', { title: 'Promptly', kind: 'info' });
      } catch (err) {
        console.error('Export failed', err);
        await message(`导出失败：${err}`, { title: 'Promptly', kind: 'error' });
      } finally {
        setExporting(false);
      }
    },
    [activeProjectId, projects]
  );

  // A3: unsaved-changes guard. Keep the latest dirty/save in refs so the
  // window-close listener (registered once) always sees current values.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const saveRef = useRef(save);
  saveRef.current = save;
  // Keep undo/redo in refs so the single keydown listener (registered once)
  // always calls the current handlers without re-subscribing.
  const undoRef = useRef(undo);
  undoRef.current = undo;
  const redoRef = useRef(redo);
  redoRef.current = redo;
  const closingRef = useRef(false);
  const tabsRef = useRef<HTMLDivElement>(null);

  // Route the custom close button + the OS close request (Alt+F4 / taskbar)
  // through one confirm flow: when there are unsaved changes, ask before
  // closing; `destroy()` bypasses the onCloseRequested guard to actually exit.
  const requestClose = useCallback(async () => {
    const win = getCurrentWindow();
    if (closingRef.current) return;
    if (!dirtyRef.current) {
      closingRef.current = true;
      await win.destroy();
      return;
    }
    const ok = await confirm('有未保存的修改，确定要关闭吗？未保存的内容将丢失。', {
      title: '关闭确认',
      kind: 'warning',
    });
    if (ok) {
      closingRef.current = true;
      await win.destroy();
    }
  }, []);

  // Guard the OS-level close request (covers window controls that go through
  // Tauri, Alt+F4, and the taskbar close) — preventDefault, then run our flow.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        unlisten = await getCurrentWindow().onCloseRequested((event) => {
          if (closingRef.current) return; // our destroy() is in progress
          event.preventDefault();
          void requestClose();
        });
      } catch (err) {
        console.error('Failed to register close guard', err);
      }
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, [requestClose]);

  // B7: single global Ctrl+S / Cmd+S handler. Previously each of the three
  // stores (gen / template / block) registered its own window keydown listener,
  // so one press fired three times and each store ran a full DELETE+reinsert.
  // Now there is exactly ONE handler here; it calls the combined save() (via
  // saveRef to avoid stale closures) which fans out to all three stores.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Horizontal scroll for tabs with mouse wheel
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      // Only handle horizontal scroll when there's overflow
      if (el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      // A regular mouse reports deltaY; a trackpad may report deltaX.
      el.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, []);

  // Single global Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z) handler for the unified
  // undo/redo timeline across 生图区 / 模板区 / 分镜区. Structural changes only —
  // a card's text editor (Tiptap/ProseMirror) has its own UndoRedo extension and
  // gets the keystroke first (its ProseMirror keymap calls preventDefault when
  // it actually undoes/redoes text). We register on window in the BUBBLE phase,
  // so by the time we run we can check e.defaultPrevented: if Tiptap already
  // consumed it (had text history to change) we do nothing; otherwise we fall
  // back to the structural timeline. This avoids the old "focus is in an editor
  // -> always skip" guard, which swallowed the shortcut whenever an editor held
  // focus even though there was no text to undo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key !== 'z' && key !== 'y') return;
      // Tiptap's editor keymap runs first (capture happens at the editor DOM
      // node) and preventDefault()s when it changed text — respect that.
      if (e.defaultPrevented) return;
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undoRef.current();
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault();
        redoRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Guard a Web/WebView reload (Ctrl+R / F5): the native beforeunload prompt.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  const [editingId, setEditingId] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId != null && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  const projectName = (id: number) =>
    projects.find((p) => p.id === id)?.name ?? '未命名项目';

  const handleRename = (id: number, name: string) => {
    setEditingId(null);
    if (name.trim()) renameProject(id, name);
  };

  // Manual window dragging. `data-tauri-drag-region` feels laggy on Windows
  // WebView2 (it debounces click-vs-drag), so we start dragging immediately on
  // mousedown over empty title-bar space instead. Interactive elements
  // (buttons/inputs/links) opt out via the `closest` check below.
  //
  // Double-click can't use onDoubleClick: once startDragging() runs on the
  // first mousedown the OS grabs the pointer and no `dblclick` is dispatched.
  // So we detect the double-click manually by timing consecutive mousedowns and
  // toggle maximize (instead of dragging) when they land close together.
  const lastDownRef = useRef(0);
  const handleTitleBarMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('button, input, a, [role="button"], [contenteditable="true"]')) {
      return;
    }
    const now = Date.now();
    if (now - lastDownRef.current < 300) {
      lastDownRef.current = 0;
      void getCurrentWindow().toggleMaximize();
      return;
    }
    lastDownRef.current = now;
    void getCurrentWindow().startDragging();
  };

  return (
    <div
      onMouseDown={handleTitleBarMouseDown}
      className="h-12 shrink-0 relative z-50 bg-[#1E1E1E] flex items-center justify-between gap-3 px-3 select-none"
    >
      <div className={`flex items-center gap-2 min-w-0 flex-1 ${IS_MAC ? 'pl-[72px]' : ''}`}>
        <AppLogo dotColor={view === 'home' ? '#E5E5E5' : dirty ? '#E0A458' : '#2EC4B6'} />

        <button
          onClick={goHome}
          title="主页"
          className={`flex items-center justify-center w-8 h-8 shrink-0 rounded-lg transition-colors cursor-pointer ${
            view === 'home'
              ? 'bg-[#2A2A2A] text-[#2EC4B6] ring-1 ring-inset ring-[#3D3D3D]'
              : 'text-[#8A8A8A] hover:bg-[#333333] hover:text-[#E5E5E5]'
          }`}
        >
          <HomeIcon size={15} />
        </button>

        <button
          onClick={goLibrary}
          title="素材库"
          className={`flex items-center gap-1.5 px-3 h-8 shrink-0 rounded-lg text-[12px] transition-colors cursor-pointer ${
            view === 'library'
              ? 'bg-[#2A2A2A] text-[#2EC4B6] ring-1 ring-inset ring-[#3D3D3D]'
              : 'bg-[#2A2A2A] hover:bg-[#333333] text-[#E5E5E5]'
          }`}
        >
          <FolderOpen size={14} />
          <span>素材库</span>
        </button>

        <div
          ref={tabsRef}
          className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto hide-scrollbar py-0.5 pl-0.5"
        >
          {openTabs.map((id) => {
            const isActive = view === 'project' && activeProjectId === id;
            return (
              <div
                key={id}
                role="button"
                onClick={() => openProject(id)}
                onDoubleClick={() => setEditingId(id)}
                className={`group flex items-center gap-2 px-3 h-8 max-w-[180px] shrink-0 rounded-lg text-[12px] cursor-pointer transition-colors ${
                  isActive
                    ? 'bg-[#2A2A2A] text-[#E5E5E5] ring-1 ring-inset ring-[#3D3D3D]'
                    : 'bg-transparent text-[#8A8A8A] hover:bg-[#252525] hover:text-[#E5E5E5]'
                }`}
              >
                {editingId === id ? (
                  <input
                    ref={inputRef}
                    defaultValue={projectName(id)}
                    onBlur={(e) => handleRename(id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRename(id, e.currentTarget.value);
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="w-[90px] bg-[#1E1E1E] text-[#E5E5E5] text-[12px] px-1 py-0.5 rounded outline-none ring-1 ring-[#2EC4B6]"
                  />
                ) : (
                  <span className="truncate flex-1">{projectName(id)}</span>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); closeTab(id); }}
                  className={`p-0.5 rounded hover:bg-[#444444] transition-colors ${
                    isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                  }`}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
          <button
            onClick={() => { if (activeStorageSpaceId != null) void createProject(undefined, activeStorageSpaceId); }}
            className="flex items-center justify-center w-8 h-8 shrink-0 rounded-lg text-[#8A8A8A] hover:bg-[#333333] hover:text-[#E5E5E5] transition-colors cursor-pointer"
            disabled={activeStorageSpaceId == null}
            title={activeStorageSpaceId == null ? '素材空间尚未就绪' : '新建项目'}
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={() => setSettingsOpen(true)}
          title="设置"
          className="flex items-center justify-center px-3 h-8 rounded-lg bg-[#2A2A2A] hover:bg-[#333333] text-[#E5E5E5] text-[12px] transition-colors cursor-pointer"
        >
          <Settings size={14} />
        </button>
        <ChipModeToggle />
        {view === 'project' ? <PanelMenu /> : null}
        {view === 'project' ? (
          <button
            onClick={() => void handleCopyAll()}
            title="合并复制生图区 / 模板区 / 分镜区的全部文本"
            className={`flex items-center gap-1.5 px-3 h-8 rounded-lg text-[12px] transition-colors cursor-pointer ${
              copiedAll
                ? 'bg-[#2EC4B6]/15 text-[#2EC4B6]'
                : 'bg-[#2A2A2A] hover:bg-[#333333] text-[#E5E5E5]'
            }`}
          >
            {copiedAll ? <Check size={13} /> : <ClipboardCopy size={13} />}
            <span>{copiedAll === 'rich' ? '已复制富文本' : copiedAll === 'plain' ? '已复制纯文本' : '复制'}</span>
          </button>
        ) : null}

        {view === 'project' ? (
          <div className="relative" ref={exportMenuRef}>
            <button
              onClick={() => setExportMenuOpen((v) => !v)}
              disabled={exporting || activeProjectId == null}
              title="导出当前项目为 .zip"
              className={`flex items-center gap-1 px-4 h-8 rounded-lg text-white text-[12px] font-medium transition-colors ${
                exporting || activeProjectId == null
                  ? 'bg-[#2EC4B6]/50 cursor-default'
                  : 'bg-[#2EC4B6] hover:bg-[#25A99C] cursor-pointer'
              }`}
            >
              <span>{exporting ? '导出中…' : '导出'}</span>
              <ChevronDown size={13} />
            </button>
            {exportMenuOpen && (
              <div className="absolute right-0 top-full mt-1 z-[9999] w-[200px] rounded-lg border border-[#3D3D3D] bg-[#252525] py-1 shadow-xl">
                <button
                  onClick={() => void handleExport(false)}
                  className="w-full text-left px-3 py-2 text-[12px] text-[#E5E5E5] hover:bg-[#333333] cursor-pointer"
                >
                  仅引用素材
                  <div className="text-[11px] text-[#8A8A8A]">只打包被引用到的素材（默认）</div>
                </button>
                <button
                  onClick={() => void handleExport(true)}
                  className="w-full text-left px-3 py-2 text-[12px] text-[#E5E5E5] hover:bg-[#333333] cursor-pointer"
                >
                  本项目全部素材
                  <div className="text-[11px] text-[#8A8A8A]">打包本项目素材库全部素材</div>
                </button>
              </div>
            )}
          </div>
        ) : null}
        {!IS_MAC && <WindowControls onRequestClose={() => void requestClose()} />}
        <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      </div>
    </div>
  );
}

// Panel visibility chooser (project view only). Toggles which of the 4 big
// panels show; the last remaining panel's toggle is locked so you can never
// close everything. "还原默认布局" resets both visibility and drag sizes.
function PanelMenu() {
  const { visible, togglePanel, isLastVisible, resetLayout } = usePanelLayout();
  const { showFormatToolbar, toggleFormatToolbar } = useGenSettings();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const items: { key: PanelKey; label: string }[] = [
    { key: 'media', label: '素材库' },
    { key: 'gen', label: '生图区' },
    { key: 'template', label: '模板区' },
    { key: 'storyboard', label: '分镜区' },
  ];

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="选择显示的面板"
        className="flex items-center justify-center px-3 h-8 rounded-lg bg-[#2A2A2A] hover:bg-[#333333] text-[#E5E5E5] text-[12px] transition-colors cursor-pointer"
      >
        <LayoutGrid size={14} />
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-[9999] w-[220px] rounded-lg border border-[#3D3D3D] bg-[#252525] py-1 shadow-xl">
          {items.map(({ key, label }) => {
            const on = visible[key];
            const locked = isLastVisible(key);
            return (
              <button
                key={key}
                onClick={() => { if (!locked) togglePanel(key); }}
                disabled={locked}
                title={locked ? '至少保留一个面板' : ''}
                className={`w-full flex items-center gap-2 text-left px-3 py-2 text-[12px] transition-colors ${
                  locked
                    ? 'text-[#666666] cursor-default'
                    : 'text-[#E5E5E5] hover:bg-[#333333] cursor-pointer'
                }`}
              >
                <span
                  className={`flex items-center justify-center w-4 h-4 rounded border ${
                    on
                      ? 'bg-[#2EC4B6] border-[#2EC4B6] text-[#1E1E1E]'
                      : 'border-[#555555] text-transparent'
                  }`}
                >
                  <Check size={12} />
                </span>
                <span className="flex-1">{label}</span>
              </button>
            );
          })}
          <div className="my-1 h-px bg-[#3D3D3D]" />
          <button
            onClick={() => toggleFormatToolbar()}
            title="分镜区顶部的富文本格式工具条"
            className="w-full flex items-center gap-2 text-left px-3 py-2 text-[12px] text-[#E5E5E5] hover:bg-[#333333] cursor-pointer"
          >
            <span
              className={`flex items-center justify-center w-4 h-4 rounded border ${
                showFormatToolbar
                  ? 'bg-[#2EC4B6] border-[#2EC4B6] text-[#1E1E1E]'
                  : 'border-[#555555] text-transparent'
              }`}
            >
              <Check size={12} />
            </span>
            <span className="flex-1">格式工具条</span>
          </button>
          <div className="my-1 h-px bg-[#3D3D3D]" />
          <button
            onClick={() => { resetLayout(); setOpen(false); }}
            className="w-full flex items-center gap-2 text-left px-3 py-2 text-[12px] text-[#E5E5E5] hover:bg-[#333333] cursor-pointer"
          >
            <RotateCcw size={13} />
            <span>还原默认布局</span>
          </button>
        </div>
      )}
    </div>
  );
}

// ============================================
// Main App
// ============================================
function ProjectWorkspace() {
  return (
    <ResizableLayout>
      <MediaLibraryPanel />
      <GenArea />
      <TemplateArea />
      <StoryboardArea />
    </ResizableLayout>
  );
}

function AppShell() {
  const { view } = useProject();

  // Safety net against the WebView navigating away when a DOM drag ends over
  // the window (e.g. dragging an <img>): swallow dragstart/dragover/drop at the
  // document level so a stray native image-drag can never replace the app with
  // the raw asset:// image. Tauri's OS file-import drop uses onDragDropEvent
  // (native layer), which is unaffected by these DOM handlers.
  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragstart', prevent);
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragstart', prevent);
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  return (
    <div
      className="flex flex-col w-[var(--app-w,100vw)] h-[var(--app-h,100vh)] bg-[#1E1E1E] overflow-hidden"
      // Fuse: overflow-hidden blocks user scroll but NOT programmatic /
      // focus-into-view scroll. If anything ever pushes the shell up, snap it
      // back to 0 so the top toolbar can never be scrolled out of view.
      onScroll={(e) => {
        if (e.currentTarget.scrollTop !== 0) e.currentTarget.scrollTop = 0;
      }}
    >
      <TopBar />
      <div className="flex-1 min-h-0 overflow-hidden">
        {view === 'home' ? (
          <Home />
        ) : view === 'library' ? (
          <MediaLibraryPage />
        ) : (
          <ProjectWorkspace />
        )}
      </div>
    </div>
  );
}

function App() {
  return (
    <ProjectProvider>
      <DragProvider>
        <MediaRevisionProvider>
          <GenSettingsProvider>
            <HistoryProvider>
              <GenStoreProvider>
                <GenTemplateStoreProvider>
                  <BlockStoreProvider>
                    <PanelLayoutProvider>
                      <ActiveEditorProvider>
                        <AppShell />
                      </ActiveEditorProvider>
                    </PanelLayoutProvider>
                  </BlockStoreProvider>
                </GenTemplateStoreProvider>
              </GenStoreProvider>
            </HistoryProvider>
          </GenSettingsProvider>
        </MediaRevisionProvider>
      </DragProvider>
    </ProjectProvider>
  );
}

export default App;
