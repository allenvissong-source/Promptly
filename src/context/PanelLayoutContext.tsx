import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from 'react';

// ============================================
// Panel layout: which of the 4 big panels are visible, and the
// drag-resized sizes. Persisted to localStorage so both visibility and
// sizes survive a restart. A one-click "还原默认布局" resets everything.
// ============================================

export type PanelKey = 'media' | 'gen' | 'template' | 'storyboard';

export interface PanelVisibility {
  media: boolean;
  gen: boolean;
  template: boolean;
  storyboard: boolean;
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
};
export const DEFAULT_H_SIZES: HSizes = [38, 31, 31];
export const DEFAULT_V_SIZES: VSizes = [58, 42];

const STORAGE_KEY = 'promptly.panelLayout';

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

function readInitial(): PersistShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<PersistShape>;
      const v = p.visible;
      const visible: PanelVisibility = {
        media: typeof v?.media === 'boolean' ? v.media : true,
        gen: typeof v?.gen === 'boolean' ? v.gen : true,
        template: typeof v?.template === 'boolean' ? v.template : true,
        storyboard: typeof v?.storyboard === 'boolean' ? v.storyboard : true,
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
    }
  } catch {
    /* ignore malformed / unavailable storage */
  }
  return {
    visible: { ...DEFAULT_VISIBLE },
    hSizes: [...DEFAULT_H_SIZES],
    vSizes: [...DEFAULT_V_SIZES],
  };
}

interface PanelLayoutValue {
  visible: PanelVisibility;
  hSizes: HSizes;
  vSizes: VSizes;
  /** How many of the 4 panels are currently visible. */
  visibleCount: number;
  /** Toggle one panel. Blocked (no-op) when it would hide the last panel. */
  togglePanel: (key: PanelKey) => void;
  /** True when this panel is the only visible one (so its toggle is locked). */
  isLastVisible: (key: PanelKey) => boolean;
  setHSizes: (updater: HSizes | ((prev: HSizes) => HSizes)) => void;
  setVSizes: (updater: VSizes | ((prev: VSizes) => VSizes)) => void;
  /** Restore default visibility + default sizes. */
  resetLayout: () => void;
}

const PanelLayoutContext = createContext<PanelLayoutValue | null>(null);

export function PanelLayoutProvider({ children }: { children: ReactNode }) {
  const initial = readInitial();
  const [visible, setVisible] = useState<PanelVisibility>(initial.visible);
  const [hSizes, setHSizesState] = useState<HSizes>(initial.hSizes);
  const [vSizes, setVSizesState] = useState<VSizes>(initial.vSizes);

  // Persist on any change.
  useEffect(() => {
    try {
      const data: PersistShape = { visible, hSizes, vSizes };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      /* ignore */
    }
  }, [visible, hSizes, vSizes]);

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
