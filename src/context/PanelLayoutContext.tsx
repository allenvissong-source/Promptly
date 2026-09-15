import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from 'react';
import { useProject } from './ProjectContext';
import { getProjectPanelLayout, setProjectPanelLayout } from '../lib/db';

// ============================================
// Panel layout: which of the 4 big panels are visible, and the
// drag-resized sizes. 另外还捎带两个卡片内部列的开关（图片区域 / 文字区域），
// 它们复用同一份存储与导出导入链路。Persisted PER PROJECT into
// projects.panel_layout
// (SQLite, schema v6) so每个项目有自己的布局，并能随项目 zip 导出导入。
// localStorage 那份（旧的全局值）保留下来，含义变成「新建 / 未设置过布局的项目
// 的默认模板」：老用户升级后打开老项目不会突然变布局，新项目也继承用户习惯。
// 布局不是业务数据：写库走 debounce，不触碰任何 store 的 dirty 流程。
// A one-click "还原默认布局" resets everything (仅影响当前项目).
// ============================================

export type PanelKey = 'media' | 'gen' | 'template' | 'storyboard';

// 卡片内部左右两列的显隐（不是面板）：ClipNoteCard 的左列=图片区域、
// 右列=文字区域。和面板一起存在同一份 panel_layout 里，所以自动获得
// 「按项目存储 + 随 zip 导出导入」的能力；但不受「至少保留一个面板」约束。
export type CardColumnKey = 'cardImages' | 'cardText';

export interface PanelVisibility {
  media: boolean;
  gen: boolean;
  template: boolean;
  storyboard: boolean;
  cardImages: boolean;
  cardText: boolean;
}

// Left | middle | right column widths (%). Sum ~= 100.
export type HSizes = [number, number, number];
// Left column: top (media) | bottom (gen) heights (%). Sum = 100.
export type VSizes = [number, number];

export const DEFAULT_VISIBLE: PanelVisibility = {
  media: true,
  gen: true,
  template: true,
  storyboard: true,
  cardImages: true,
  cardText: true,
};
export const DEFAULT_H_SIZES: HSizes = [38, 31, 31];
export const DEFAULT_V_SIZES: VSizes = [58, 42];

const STORAGE_KEY = 'promptly.panelLayout';

// 拖拽分栏会每帧触发一次状态更新；攒够这么久没有新变化才落库一次。
const PERSIST_DEBOUNCE_MS = 400;

interface PersistShape {
  visible: PanelVisibility;
  hSizes: HSizes;
  vSizes: VSizes;
}

function isNumTriple(a: unknown): a is HSizes {
  return (
    Array.isArray(a) &&
    a.length === 3 &&
    a.every((n) => typeof n === 'number' && isFinite(n))
  );
}
function isNumPair(a: unknown): a is VSizes {
  return (
    Array.isArray(a) &&
    a.length === 2 &&
    a.every((n) => typeof n === 'number' && isFinite(n))
  );
}

// 逐字段校验一份序列化布局；脏数据 / 半截数据都会被逐项回退到默认值，解析不出
// 任何东西时返回 null（交给调用方走下一级回退）。
function parseLayout(raw: string | null | undefined): PersistShape | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<PersistShape>;
    if (!p || typeof p !== 'object') return null;
    const v = p.visible;
    const visible: PanelVisibility = {
      media: typeof v?.media === 'boolean' ? v.media : true,
      gen: typeof v?.gen === 'boolean' ? v.gen : true,
      template: typeof v?.template === 'boolean' ? v.template : true,
      storyboard: typeof v?.storyboard === 'boolean' ? v.storyboard : true,
      // 老项目的 panel_layout 里没有这两个字段 → 一律回退成 true，
      // 否则打开老项目会以为卡片内容全没了。
      cardImages: typeof v?.cardImages === 'boolean' ? v.cardImages : true,
      cardText: typeof v?.cardText === 'boolean' ? v.cardText : true,
    };
    // Never restore an all-closed state (shouldn't happen, but be safe).
    if (!visible.media && !visible.gen && !visible.template && !visible.storyboard) {
      visible.media = visible.gen = visible.template = visible.storyboard = true;
    }
    return {
      visible,
      hSizes: isNumTriple(p.hSizes) ? p.hSizes : [...DEFAULT_H_SIZES],
      vSizes: isNumPair(p.vSizes) ? p.vSizes : [...DEFAULT_V_SIZES],
    };
  } catch {
    /* ignore malformed / unavailable storage */
  }
  return null;
}

function defaultLayout(): PersistShape {
  return {
    visible: { ...DEFAULT_VISIBLE },
    hSizes: [...DEFAULT_H_SIZES],
    vSizes: [...DEFAULT_V_SIZES],
  };
}

// 「默认模板」：localStorage 里那份（旧的全局布局 / 用户最近一次调整）。项目自己
// 没有布局时用它，再兜底到出厂默认。
function readTemplate(): PersistShape {
  try {
    return parseLayout(localStorage.getItem(STORAGE_KEY)) ?? defaultLayout();
  } catch {
    return defaultLayout();
  }
}

interface PanelLayoutValue {
  visible: PanelVisibility;
  hSizes: HSizes;
  vSizes: VSizes;
  /** How many of the 4 panels are currently visible. */
  visibleCount: number;
  /** Toggle one panel. Blocked (no-op) when it would hide the last panel. */
  togglePanel: (key: PanelKey) => void;
  /** Toggle a card's image / text column. Never blocked (both may be off). */
  toggleCardColumn: (key: CardColumnKey) => void;
  /** True when this panel is the only visible one (so its toggle is locked). */
  isLastVisible: (key: PanelKey) => boolean;
  setHSizes: (updater: HSizes | ((prev: HSizes) => HSizes)) => void;
  setVSizes: (updater: VSizes | ((prev: VSizes) => VSizes)) => void;
  /** Restore default visibility + default sizes. */
  resetLayout: () => void;
}

const PanelLayoutContext = createContext<PanelLayoutValue | null>(null);

export function PanelLayoutProvider({ children }: { children: ReactNode }) {
  const { activeProjectId, view } = useProject();
  // 首屏先用「默认模板」，避免项目布局异步加载期间闪一下出厂默认。
  const initial = readTemplate();
  const [visible, setVisible] = useState<PanelVisibility>(initial.visible);
  const [hSizes, setHSizesState] = useState<HSizes>(initial.hSizes);
  const [vSizes, setVSizesState] = useState<VSizes>(initial.vSizes);

  // 当前 state 属于哪个项目（已 hydrate 完成）。null = 还没认领任何项目，此时
  // 不允许回写，否则会把上一个项目的布局写进刚切过来的项目。
  const hydratedForRef = useRef<number | null>(null);
  // 尚未落库的最新一份布局 + 它属于哪个项目。
  const pendingRef = useRef<{ projectId: number; json: string } | null>(null);
  const timerRef = useRef<number | null>(null);

  // 立刻把 pending 的写入落库（项目切走 / 离开项目视图 / 卸载 / 关窗时调用）。
  const flushPending = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (!pending) return;
    setProjectPanelLayout(pending.projectId, pending.json).catch((err) => {
      console.error('Failed to persist project panel layout', err);
    });
  }, []);

  // 切换项目：把上一个项目 pending 的写入 flush 掉，再异步加载新项目的布局。
  // 回退顺序：① 项目自己的 panel_layout → ② localStorage 旧全局值（默认模板）
  // → ③ 出厂默认（readTemplate 内部已兜底）。
  useEffect(() => {
    if (view !== 'project' || activeProjectId == null) return;
    if (hydratedForRef.current === activeProjectId) return;
    flushPending();
    hydratedForRef.current = null;
    const projectId = activeProjectId;
    let cancelled = false;
    (async () => {
      let stored: string | null = null;
      try {
        stored = await getProjectPanelLayout(projectId);
      } catch (err) {
        console.error('Failed to load project panel layout', err);
      }
      if (cancelled) return;
      const next = parseLayout(stored) ?? readTemplate();
      hydratedForRef.current = projectId;
      setVisible(next.visible);
      setHSizesState(next.hSizes);
      setVSizesState(next.vSizes);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, view, flushPending]);

  // Persist on any change: localStorage 立即更新（新建项目的默认模板），当前项目
  // 的那份 debounce 后落库。首页 / 素材库视图不写库。
  useEffect(() => {
    const data: PersistShape = { visible, hSizes, vSizes };
    const json = JSON.stringify(data);
    try {
      localStorage.setItem(STORAGE_KEY, json);
    } catch {
      /* ignore */
    }
    if (view !== 'project' || activeProjectId == null) return;
    if (hydratedForRef.current !== activeProjectId) return;
    pendingRef.current = { projectId: activeProjectId, json };
    if (timerRef.current != null) clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      flushPending();
    }, PERSIST_DEBOUNCE_MS);
  }, [visible, hSizes, vSizes, activeProjectId, view, flushPending]);

  // 离开项目视图 / 卸载 / 关窗：别把 pending 的布局丢掉。
  useEffect(() => {
    if (view !== 'project') flushPending();
  }, [view, flushPending]);

  useEffect(() => {
    const onBeforeUnload = () => flushPending();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      flushPending();
    };
  }, [flushPending]);

  const visibleCount =
    (visible.media ? 1 : 0) +
    (visible.gen ? 1 : 0) +
    (visible.template ? 1 : 0) +
    (visible.storyboard ? 1 : 0);

  const togglePanel = useCallback((key: PanelKey) => {
    setVisible((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      const count =
        (next.media ? 1 : 0) +
        (next.gen ? 1 : 0) +
        (next.template ? 1 : 0) +
        (next.storyboard ? 1 : 0);
      // Cannot close all panels — keep at least one.
      if (count === 0) return prev;
      return next;
    });
  }, []);

  // 卡片内部的图片/文字列：不参与「至少保留一个面板」的限制，两个都关也允许
  // （此时卡片只剩标题栏）。
  const toggleCardColumn = useCallback((key: CardColumnKey) => {
    setVisible((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const isLastVisible = useCallback(
    (key: PanelKey) => {
      const count =
        (visible.media ? 1 : 0) +
        (visible.gen ? 1 : 0) +
        (visible.template ? 1 : 0) +
        (visible.storyboard ? 1 : 0);
      return count === 1 && visible[key];
    },
    [visible]
  );

  const setHSizes = useCallback(
    (updater: HSizes | ((prev: HSizes) => HSizes)) => {
      setHSizesState((prev) =>
        typeof updater === 'function' ? updater(prev) : updater
      );
    },
    []
  );
  const setVSizes = useCallback(
    (updater: VSizes | ((prev: VSizes) => VSizes)) => {
      setVSizesState((prev) =>
        typeof updater === 'function' ? updater(prev) : updater
      );
    },
    []
  );

  const resetLayout = useCallback(() => {
    setVisible({ ...DEFAULT_VISIBLE });
    setHSizesState([...DEFAULT_H_SIZES]);
    setVSizesState([...DEFAULT_V_SIZES]);
  }, []);

  const value: PanelLayoutValue = {
    visible,
    hSizes,
    vSizes,
    visibleCount,
    togglePanel,
    toggleCardColumn,
    isLastVisible,
    setHSizes,
    setVSizes,
    resetLayout,
  };

  return (
    <PanelLayoutContext.Provider value={value}>
      {children}
    </PanelLayoutContext.Provider>
  );
}

export function usePanelLayout(): PanelLayoutValue {
  const ctx = useContext(PanelLayoutContext);
  if (!ctx) {
    throw new Error('usePanelLayout must be used within a PanelLayoutProvider');
  }
  return ctx;
}
