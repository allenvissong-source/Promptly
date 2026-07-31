import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import { useProject } from './ProjectContext';

// Unified undo/redo timeline shared by the three area stores (生图区 / 模板区 /
// 分镜区). One linear history: a Ctrl+Z undoes the last STRUCTURAL change made
// in ANY area, regardless of which area it happened in. Plain-text editing
// inside a card is intentionally NOT tracked here — that is left to Tiptap's own
// per-editor history so typing undo stays fine-grained and local.
//
// Design: each store registers a { snapshot, restore } pair. Before a structural
// mutation a store calls record(area), which deep-clones that area's current
// state onto the `past` stack (and clears `future`). undo() pops `past`, pushes
// the area's CURRENT state onto `future`, and restores the popped snapshot;
// redo() is the mirror. Snapshots are JSON deep-clones (all store state is
// JSON-serializable), so restore is a pure setState with no aliasing.

export type HistoryArea = 'gen' | 'tpl' | 'blk';

interface AreaApi {
  snapshot: () => unknown;
  restore: (data: unknown) => void;
}

interface HistoryEntry {
  area: HistoryArea;
  data: unknown;
}

interface HistoryValue {
  register: (area: HistoryArea, api: AreaApi) => void;
  record: (area: HistoryArea) => void;
  undo: () => void;
  redo: () => void;
  reset: () => void;
}

const HistoryContext = createContext<HistoryValue | null>(null);

export function useHistory(): HistoryValue {
  const ctx = useContext(HistoryContext);
  if (!ctx) throw new Error('useHistory must be used within HistoryProvider');
  return ctx;
}

// Cap the stacks so a long editing session can't grow memory unbounded.
const MAX_DEPTH = 100;

export function HistoryProvider({ children }: { children: ReactNode }) {
  const { activeProjectId } = useProject();
  const apisRef = useRef<Partial<Record<HistoryArea, AreaApi>>>({});
  const pastRef = useRef<HistoryEntry[]>([]);
  const futureRef = useRef<HistoryEntry[]>([]);

  const register = useCallback((area: HistoryArea, api: AreaApi) => {
    apisRef.current[area] = api;
  }, []);

  const reset = useCallback(() => {
    pastRef.current = [];
    futureRef.current = [];
  }, []);

  // Switching projects hydrates fresh state into every store; discard the old
  // project's timeline so an undo can't drag in unrelated state.
  useEffect(() => {
    reset();
  }, [activeProjectId, reset]);

  const record = useCallback((area: HistoryArea) => {
    const api = apisRef.current[area];
    if (!api) return;
    pastRef.current.push({ area, data: api.snapshot() });
    if (pastRef.current.length > MAX_DEPTH) pastRef.current.shift();
    // A fresh structural change invalidates the redo branch.
    futureRef.current = [];
  }, []);

  const undo = useCallback(() => {
    const entry = pastRef.current.pop();
    if (!entry) return;
    const api = apisRef.current[entry.area];
    if (!api) return;
    futureRef.current.push({ area: entry.area, data: api.snapshot() });
    api.restore(entry.data);
  }, []);

  const redo = useCallback(() => {
    const entry = futureRef.current.pop();
    if (!entry) return;
    const api = apisRef.current[entry.area];
    if (!api) return;
    pastRef.current.push({ area: entry.area, data: api.snapshot() });
    api.restore(entry.data);
  }, []);

  return (
    <HistoryContext.Provider value={{ register, record, undo, redo, reset }}>
      {children}
    </HistoryContext.Provider>
  );
}
