import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import type { ReactNode } from 'react';
import {
  initDb,
  listStorageSpaces,
  getStorageSpace,
  getAppSetting,
  setAppSetting,
  listExportFormatRules,
  type StorageSpace,
} from '../lib/db';
import { useMediaRevision } from './MediaRevisionContext';
import {
  DEFAULT_EXPORT_FORMAT_RULES,
  type ExportFormatRule as ClipboardExportFormatRule,
} from '../lib/richClipboard';

// How @ chips in the gen-area (生图区) text box are displayed.
//  - 'code': the derived ordinal, e.g. "Image1" / "Image2" (order-driven)
//  - 'name': the material file name without extension
// Neither mode keeps the leading "@".
export type ChipMode = 'code' | 'name';

const CHIP_MODE_KEY = 'promptly.chipMode';
const SHOW_FORMAT_TOOLBAR_KEY = 'promptly.showFormatToolbar';
const COPY_AS_TABLE_CELL_KEY = 'promptly.copyAsTableCell';
const APPLY_REPLACE_ON_EXPORT_KEY = 'promptly.applyReplaceOnExport';
const AUTO_SAVE_ENABLED_KEY = 'promptly.autoSaveEnabled';
const AUTO_SAVE_INTERVAL_KEY = 'promptly.autoSaveIntervalMs';

// 自动保存的空闲防抖档位：设置里只给这两档，避免用户填出 50ms 这种自残值。
export const AUTO_SAVE_INTERVAL_OPTIONS = [1500, 5000] as const;
export type AutoSaveIntervalMs = (typeof AUTO_SAVE_INTERVAL_OPTIONS)[number];
const AUTO_SAVE_INTERVAL_DEFAULT: AutoSaveIntervalMs = 1500;

function parseAutoSaveInterval(
  value: string | null,
  fallback: AutoSaveIntervalMs
): AutoSaveIntervalMs {
  const n = Number(value);
  return AUTO_SAVE_INTERVAL_OPTIONS.find((opt) => opt === n) ?? fallback;
}

function readInitialChipMode(): ChipMode {
  try {
    const v = localStorage.getItem(CHIP_MODE_KEY);
    if (v === 'code' || v === 'name') return v;
  } catch {
    // localStorage unavailable (e.g. SSR / privacy mode) — fall back below.
  }
  return 'code';
}

function readInitialShowFormatToolbar(): boolean {
  try {
    const v = localStorage.getItem(SHOW_FORMAT_TOOLBAR_KEY);
    if (v === '0') return false;
    if (v === '1') return true;
  } catch {
    // localStorage unavailable — fall back to default (shown).
  }
  return true;
}

function readInitialCopyAsTableCell(): boolean {
  try {
    const v = localStorage.getItem(COPY_AS_TABLE_CELL_KEY);
    if (v === '0') return false;
    if (v === '1') return true;
  } catch {
    // localStorage unavailable — fall back to default (on).
  }
  return true;
}

function readInitialApplyReplaceOnExport(): boolean {
  try {
    const v = localStorage.getItem(APPLY_REPLACE_ON_EXPORT_KEY);
    if (v === '0') return false;
    if (v === '1') return true;
  } catch {
    // localStorage unavailable — fall back to default (on).
  }
  return true;
}

function readInitialAutoSaveEnabled(): boolean {
  try {
    const v = localStorage.getItem(AUTO_SAVE_ENABLED_KEY);
    if (v === '0') return false;
    if (v === '1') return true;
  } catch {
    // localStorage unavailable — fall back to default (on).
  }
  return true;
}

function readInitialAutoSaveInterval(): AutoSaveIntervalMs {
  try {
    return parseAutoSaveInterval(
      localStorage.getItem(AUTO_SAVE_INTERVAL_KEY),
      AUTO_SAVE_INTERVAL_DEFAULT
    );
  } catch {
    // localStorage unavailable — fall back to default (1.5s).
  }
  return AUTO_SAVE_INTERVAL_DEFAULT;
}

function parseChipMode(value: string | null, fallback: ChipMode): ChipMode {
  return value === 'code' || value === 'name' ? value : fallback;
}

function parseBool(value: string | null, fallback: boolean): boolean {
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return fallback;
}

function dbRulesToClipboardRules(rules: Awaited<ReturnType<typeof listExportFormatRules>>): ClipboardExportFormatRule[] {
  if (!rules.length) return DEFAULT_EXPORT_FORMAT_RULES;
  return rules.map((r) => ({
    id: r.id,
    name: r.name,
    pattern: r.pattern,
    enabled: r.enabled !== 0,
    sortOrder: r.sort_order,
    bold: r.bold !== 0,
    italic: r.italic !== 0,
    underline: r.underline !== 0,
    strike: r.strike !== 0,
    textColor: r.text_color || null,
    mode: r.rule_mode === 'replace' ? 'replace' : 'style',
    replacement: r.replacement ?? '',
  }));
}

interface GenSettingsValue {
  chipMode: ChipMode;
  setChipMode: (mode: ChipMode) => void;
  toggleChipMode: () => void;
  // 是否显示分镜区顶部的富文本格式工具条（默认显示，可在设置里关）。
  showFormatToolbar: boolean;
  setShowFormatToolbar: (v: boolean) => void;
  toggleFormatToolbar: () => void;
  // 复制到表格类目标（飞书表格 / Excel）时，是否把整段文本放进同一个单元格
  // （单元格内保留换行），而不是每个换行拆成一行。默认开启。
  copyAsTableCell: boolean;
  setCopyAsTableCell: (v: boolean) => void;
  // 复制 / 导出文本时是否自动执行「替换类」格式规则（设置 → 复制格式里 mode
  // 为 replace 的规则）。默认开启；关掉后复制结果与旧版本完全一致。
  applyReplaceOnExport: boolean;
  setApplyReplaceOnExport: (v: boolean) => void;
  // 自动保存总开关（默认开）。关掉后调度器不再自发落库，只剩 Ctrl+S 手动保存，
  // 关窗时也回到「有未保存修改」的二次确认弹窗。
  autoSaveEnabled: boolean;
  setAutoSaveEnabled: (v: boolean) => void;
  // 空闲防抖间隔：停止编辑多久后落库（1.5 秒 / 5 秒，默认 1.5 秒）。
  autoSaveIntervalMs: AutoSaveIntervalMs;
  setAutoSaveIntervalMs: (v: AutoSaveIntervalMs) => void;
  storageSpaces: StorageSpace[];
  activeStorageSpaceId: number | null;
  activeStorageSpace: StorageSpace | null;
  exportFormatRules: ClipboardExportFormatRule[];
  loading: boolean;
  storageBusy: boolean;
  refreshSettings: () => Promise<void>;
  switchStorageSpace: (id: number) => Promise<void>;
}

const GenSettingsContext = createContext<GenSettingsValue | null>(null);

export function useGenSettings() {
  const ctx = useContext(GenSettingsContext);
  if (!ctx) throw new Error('useGenSettings must be used within GenSettingsProvider');
  return ctx;
}

export function GenSettingsProvider({ children }: { children: ReactNode }) {
  const [chipModeState, setChipModeState] = useState<ChipMode>(readInitialChipMode);
  const [showFormatToolbarState, setShowFormatToolbarState] = useState<boolean>(
    readInitialShowFormatToolbar
  );
  const [copyAsTableCellState, setCopyAsTableCellState] = useState<boolean>(
    readInitialCopyAsTableCell
  );
  const [applyReplaceOnExportState, setApplyReplaceOnExportState] = useState<boolean>(
    readInitialApplyReplaceOnExport
  );
  const [autoSaveEnabledState, setAutoSaveEnabledState] = useState<boolean>(
    readInitialAutoSaveEnabled
  );
  const [autoSaveIntervalMsState, setAutoSaveIntervalMsState] = useState<AutoSaveIntervalMs>(
    readInitialAutoSaveInterval
  );
  const [storageSpaces, setStorageSpaces] = useState<StorageSpace[]>([]);
  const [activeStorageSpaceId, setActiveStorageSpaceId] = useState<number | null>(null);
  const [exportFormatRules, setExportFormatRules] = useState<ClipboardExportFormatRule[]>(DEFAULT_EXPORT_FORMAT_RULES);
  const [loading, setLoading] = useState(true);
  const [storageBusy, setStorageBusy] = useState(false);
  const { bump } = useMediaRevision();

  const refreshSettings = useCallback(async () => {
    setLoading(true);
    try {
      await initDb();
      const [spaces, chipSetting, toolbarSetting, tableCellSetting, replaceSetting, autoSaveSetting, autoSaveIntervalSetting, activeSetting, dbRules] = await Promise.all([
        listStorageSpaces(),
        getAppSetting('chip_mode'),
        getAppSetting('show_format_toolbar'),
        getAppSetting('copy_as_table_cell'),
        getAppSetting('apply_replace_on_export'),
        getAppSetting('auto_save_enabled'),
        getAppSetting('auto_save_interval_ms'),
        getAppSetting('active_storage_space_id'),
        listExportFormatRules(),
      ]);
      let nextActiveId = activeSetting ? Number(activeSetting) : NaN;
      if (!Number.isFinite(nextActiveId) || !spaces.some((s) => s.id === nextActiveId)) {
        nextActiveId = spaces[0]?.id ?? NaN;
        if (Number.isFinite(nextActiveId)) await setAppSetting('active_storage_space_id', String(nextActiveId));
      }
      const localChip = readInitialChipMode();
      const localToolbar = readInitialShowFormatToolbar();
      const localTableCell = readInitialCopyAsTableCell();
      const localApplyReplace = readInitialApplyReplaceOnExport();
      const nextChip = parseChipMode(chipSetting, localChip);
      const nextToolbar = parseBool(toolbarSetting, localToolbar);
      const nextTableCell = parseBool(tableCellSetting, localTableCell);
      const nextApplyReplace = parseBool(replaceSetting, localApplyReplace);
      const nextAutoSave = parseBool(autoSaveSetting, readInitialAutoSaveEnabled());
      const nextAutoSaveInterval = parseAutoSaveInterval(
        autoSaveIntervalSetting,
        readInitialAutoSaveInterval()
      );
      if (chipSetting == null) await setAppSetting('chip_mode', nextChip);
      if (toolbarSetting == null) await setAppSetting('show_format_toolbar', String(nextToolbar));
      if (tableCellSetting == null) await setAppSetting('copy_as_table_cell', String(nextTableCell));
      if (replaceSetting == null) await setAppSetting('apply_replace_on_export', String(nextApplyReplace));
      if (autoSaveSetting == null) await setAppSetting('auto_save_enabled', String(nextAutoSave));
      if (autoSaveIntervalSetting == null) await setAppSetting('auto_save_interval_ms', String(nextAutoSaveInterval));
      setStorageSpaces(spaces);
      setActiveStorageSpaceId(Number.isFinite(nextActiveId) ? nextActiveId : null);
      setChipModeState(nextChip);
      setShowFormatToolbarState(nextToolbar);
      setCopyAsTableCellState(nextTableCell);
      setApplyReplaceOnExportState(nextApplyReplace);
      setAutoSaveEnabledState(nextAutoSave);
      setAutoSaveIntervalMsState(nextAutoSaveInterval);
      setExportFormatRules(dbRulesToClipboardRules(dbRules));
    } catch (err) {
      console.error('Failed to load gen settings', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshSettings();
  }, [refreshSettings]);

  const setChipMode = useCallback((mode: ChipMode) => {
    setChipModeState(mode);
    void setAppSetting('chip_mode', mode).catch((err) => console.error('Persist chip mode failed', err));
  }, []);

  const setShowFormatToolbar = useCallback((value: boolean) => {
    setShowFormatToolbarState(value);
    void setAppSetting('show_format_toolbar', String(value)).catch((err) => console.error('Persist format toolbar failed', err));
  }, []);

  const setCopyAsTableCell = useCallback((value: boolean) => {
    setCopyAsTableCellState(value);
    void setAppSetting('copy_as_table_cell', String(value)).catch((err) => console.error('Persist copy-as-table-cell failed', err));
  }, []);

  const setApplyReplaceOnExport = useCallback((value: boolean) => {
    setApplyReplaceOnExportState(value);
    void setAppSetting('apply_replace_on_export', String(value)).catch((err) => console.error('Persist apply-replace-on-export failed', err));
  }, []);

  const setAutoSaveEnabled = useCallback((value: boolean) => {
    setAutoSaveEnabledState(value);
    void setAppSetting('auto_save_enabled', String(value)).catch((err) => console.error('Persist auto-save-enabled failed', err));
  }, []);

  const setAutoSaveIntervalMs = useCallback((value: AutoSaveIntervalMs) => {
    setAutoSaveIntervalMsState(value);
    void setAppSetting('auto_save_interval_ms', String(value)).catch((err) => console.error('Persist auto-save-interval failed', err));
  }, []);

  const toggleChipMode = useCallback(
    () => setChipMode(chipModeState === 'code' ? 'name' : 'code'),
    [chipModeState, setChipMode]
  );
  const toggleFormatToolbar = useCallback(
    () => setShowFormatToolbar(!showFormatToolbarState),
    [setShowFormatToolbar, showFormatToolbarState]
  );

  const switchStorageSpace = useCallback(async (id: number) => {
    setStorageBusy(true);
    try {
      const exists = await getStorageSpace(id);
      if (!exists) throw new Error(`Storage space ${id} does not exist`);
      await setAppSetting('active_storage_space_id', String(id));
      setActiveStorageSpaceId(id);
      bump();
    } finally {
      setStorageBusy(false);
    }
  }, [bump]);

  const activeStorageSpace =
    storageSpaces.find((space) => space.id === activeStorageSpaceId) ?? null;

  return (
    <GenSettingsContext.Provider value={{
        chipMode: chipModeState,
        setChipMode,
        toggleChipMode,
        showFormatToolbar: showFormatToolbarState,
        setShowFormatToolbar,
        toggleFormatToolbar,
        copyAsTableCell: copyAsTableCellState,
        setCopyAsTableCell,
        applyReplaceOnExport: applyReplaceOnExportState,
        setApplyReplaceOnExport,
        autoSaveEnabled: autoSaveEnabledState,
        setAutoSaveEnabled,
        autoSaveIntervalMs: autoSaveIntervalMsState,
        setAutoSaveIntervalMs,
        storageSpaces,
        activeStorageSpaceId,
        activeStorageSpace,
        exportFormatRules,
        loading,
        storageBusy,
        refreshSettings,
        switchStorageSpace,
      }}>
      {children}
    </GenSettingsContext.Provider>
  );
}
